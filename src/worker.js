const SUPABASE_URL = "https://bcgdqepzakcufaadgnda.supabase.co";
const API_KEY = "sb_publishable_wHqWLjQwO2lMwkGLeBktng_Mk_xf5xd";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function fetchMeta(id) {
  const url =
    `${SUPABASE_URL}/rest/v1/preprints_with_ratings_mat` +
    `?select=id,pdf_path,manuscript_title,author_name,institution,discipline,created_at,viscosity` +
    `&id=eq.${id}`;
  const res = await fetch(url, {
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

async function fetchSignedUrl(pdfPath) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/manuscripts/${pdfPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const { signedURL } = await res.json();
  return signedURL ? `${SUPABASE_URL}/storage/v1${signedURL}` : null;
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

  const row = await fetchMeta(id);
  if (!row) return json({ error: "Preprint not found" }, 404);
  if (!row.pdf_path) return json({ error: "No PDF available" }, 404);

  const body = {
    id: row.id,
    title: row.manuscript_title,
    author: row.author_name,
    institution: row.institution,
    discipline: row.discipline,
    viscosity: row.viscosity,
    created_at: row.created_at,
    pdf_path: row.pdf_path,
    filename: row.pdf_path.split("/").pop(),
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
// R2 持久存储：首次从 Supabase 拉取并写入 R2，后续直接从 R2 返回
async function handleDownload(id, bucket) {
  const r2Key = `pdfs/${id}.pdf`;

  // 1. 查 R2
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

  // 2. R2 未命中 → 回源 Supabase
  const row = await fetchMeta(id);
  if (!row || !row.pdf_path) return json({ error: "PDF not found" }, 404);

  const signedUrl = await fetchSignedUrl(row.pdf_path);
  if (!signedUrl) return json({ error: "Failed to get signed URL" }, 502);

  const pdfRes = await fetch(signedUrl);
  if (!pdfRes.ok) return json({ error: "Failed to download PDF" }, 502);

  const title = (row.manuscript_title || "").replace(/[^\w\u4e00-\u9fff\s-]/g, "").slice(0, 80);
  const safeName = title ? `${title}.pdf` : row.pdf_path.split("/").pop();
  const pdfBody = await pdfRes.arrayBuffer();

  // 3. 写入 R2（后台执行，不阻塞响应）
  const putPromise = bucket.put(r2Key, pdfBody, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: {
      meta: JSON.stringify({
        safeName,
        title: row.manuscript_title,
        author: row.author_name,
        id: row.id,
        storedAt: new Date().toISOString(),
      }),
    },
  });

  // 4. 并行返回响应 + 写 R2
  const response = new Response(pdfBody, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      "Content-Length": pdfBody.byteLength.toString(),
      "X-Cache": "MISS",
      ...CORS,
    },
  });

  // waitUntil 让 R2 写入在响应返回后继续执行
  return { response, putPromise };
}

// ── Router ───────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/api/info") {
      const id = extractId(url.searchParams.get("id"));
      if (!id) return json({ error: "Invalid preprint ID" }, 400);
      return handleInfo(id);
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

    // 非 API 路由交给 Assets 处理（静态文件）
    return env.ASSETS.fetch(request);
  },
};
