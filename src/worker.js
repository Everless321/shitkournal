const API_BASE = "https://api.shitjournal.org/api";
const FILES_BASE = "https://files.shitjournal.org";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ZONES = ["latrine", "septic", "stone", "sediment"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const META_TTL = 86400; // 24h

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function extractId(input) {
  const m = (input || "").match(UUID_RE);
  return m ? m[0] : null;
}

// ── /api/info ────────────────────────────────────────
async function handleInfo(id) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/meta/${id}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return json({ ...body, _cache: "HIT" });
  }

  const res = await fetch(`${API_BASE}/articles/${id}`);
  if (!res.ok) return json({ error: "Article not found" }, 404);

  const { article } = await res.json();
  if (!article) return json({ error: "Article not found" }, 404);

  const body = {
    id: article.id,
    title: article.title,
    author: article.author?.display_name,
    institution: article.author?.institution,
    discipline: article.discipline,
    zone: article.zones,
    created_at: article.created_at,
    pdf_url: article.pdf_url,
    filename: `${article.id}.pdf`,
  };

  const toCache = new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${META_TTL}`,
    },
  });
  await cache.put(cacheKey, toCache);

  return json({ ...body, _cache: "MISS" });
}

// ── /api/download ────────────────────────────────────
async function handleDownload(id, bucket) {
  const r2Key = `pdfs/${id}.pdf`;

  const r2Obj = await bucket.get(r2Key);
  if (r2Obj) {
    const meta = JSON.parse(r2Obj.customMetadata?.meta || "{}");
    const safeName = meta.safeName || `${id}.pdf`;
    return new Response(r2Obj.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
        "Content-Length": r2Obj.size.toString(),
        "X-Cache": "R2",
        ...CORS,
      },
    });
  }

  const pdfUrl = `${FILES_BASE}/${id}.pdf`;
  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) return json({ error: "PDF not found" }, 404);

  let safeName = `${id}.pdf`;
  try {
    const metaRes = await fetch(`${API_BASE}/articles/${id}`);
    if (metaRes.ok) {
      const { article } = await metaRes.json();
      if (article?.title) {
        const title = article.title.replace(/[^\w\u4e00-\u9fff\s-]/g, "").slice(0, 80);
        safeName = `${title}.pdf`;
      }
    }
  } catch {}

  const pdfBody = await pdfRes.arrayBuffer();

  const putPromise = bucket.put(r2Key, pdfBody, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { meta: JSON.stringify({ safeName, id, storedAt: new Date().toISOString() }) },
  });

  const response = new Response(pdfBody, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      "Content-Length": pdfBody.byteLength.toString(),
      "X-Cache": "MISS",
      ...CORS,
    },
  });

  return { response, putPromise };
}

// ── /api/list ────────────────────────────────────────
async function handleList() {
  const all = [];

  for (const zone of ZONES) {
    let page = 1;
    while (true) {
      const res = await fetch(`${API_BASE}/articles/?zone=${zone}&page=${page}`);
      if (!res.ok) break;
      const data = await res.json();
      if (!data.data?.length) break;

      for (const a of data.data) {
        if (a.pdf_url) {
          all.push({ id: a.id, title: a.title, author: a.author?.display_name, pdf_url: a.pdf_url });
        }
      }

      if (page >= data.total_pages) break;
      page++;
    }
  }

  return json({ total: all.length, preprints: all });
}

// ── /api/warm ────────────────────────────────────────
async function handleWarm(id, bucket) {
  const r2Key = `pdfs/${id}.pdf`;

  const head = await bucket.head(r2Key);
  if (head) return json({ id, status: "exists", size: head.size });

  const pdfUrl = `${FILES_BASE}/${id}.pdf`;
  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) return json({ id, status: "download_failed" }, 502);

  // 获取标题用于文件名（可选，失败不影响缓存）
  let safeName = `${id}.pdf`;
  try {
    const metaRes = await fetch(`${API_BASE}/articles/${id}`);
    if (metaRes.ok) {
      const { article } = await metaRes.json();
      if (article?.title) {
        const title = article.title.replace(/[^\w\u4e00-\u9fff\s-]/g, "").slice(0, 80);
        safeName = `${title}.pdf`;
      }
    }
  } catch {}

  const pdfBody = await pdfRes.arrayBuffer();

  await bucket.put(r2Key, pdfBody, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { meta: JSON.stringify({ safeName, id, storedAt: new Date().toISOString() }) },
  });

  return json({ id, status: "cached", size: pdfBody.byteLength });
}

// ── Router ───────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/info") {
        const id = extractId(url.searchParams.get("id"));
        if (!id) return json({ error: "Invalid preprint ID" }, 400);
        return handleInfo(id);
      }

      if (url.pathname === "/api/list") {
        return handleList();
      }

      if (url.pathname === "/api/warm") {
        const id = extractId(url.searchParams.get("id"));
        if (!id) return json({ error: "Invalid preprint ID" }, 400);
        return handleWarm(id, env.PDF_BUCKET);
      }

      if (url.pathname === "/api/download") {
        const id = extractId(url.searchParams.get("id"));
        if (!id) return json({ error: "Invalid preprint ID" }, 400);
        const result = await handleDownload(id, env.PDF_BUCKET);
        if (result.putPromise) {
          ctx.waitUntil(result.putPromise);
          return result.response;
        }
        return result;
      }
    }

    return env.ASSETS.fetch(request);
  },
};
