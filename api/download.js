const SUPABASE_URL = "https://bcgdqepzakcufaadgnda.supabase.co";
const API_KEY = "sb_publishable_wHqWLjQwO2lMwkGLeBktng_Mk_xf5xd";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default async function handler(req, res) {
  const input = req.query.id || "";
  const match = input.match(UUID_RE);
  if (!match) {
    return res.status(400).json({ error: "Invalid preprint ID" });
  }
  const id = match[0];

  const metaUrl =
    `${SUPABASE_URL}/rest/v1/preprints_with_ratings_mat` +
    `?select=id,pdf_path,manuscript_title` +
    `&id=eq.${id}`;

  const metaRes = await fetch(metaUrl, {
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
  });
  if (!metaRes.ok) {
    return res.status(502).json({ error: "Supabase query failed" });
  }

  const rows = await metaRes.json();
  if (!rows.length || !rows[0].pdf_path) {
    return res.status(404).json({ error: "PDF not found" });
  }

  const row = rows[0];
  const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/manuscripts/${row.pdf_path}`;
  const signRes = await fetch(signUrl, {
    method: "POST",
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!signRes.ok) {
    return res.status(502).json({ error: "Failed to get signed URL" });
  }

  const { signedURL } = await signRes.json();
  const downloadUrl = `${SUPABASE_URL}/storage/v1${signedURL}`;

  const pdfRes = await fetch(downloadUrl);
  if (!pdfRes.ok) {
    return res.status(502).json({ error: "Failed to download PDF" });
  }

  const filename = row.pdf_path.split("/").pop();
  const title = (row.manuscript_title || "").replace(/[^\w\u4e00-\u9fff\s-]/g, "").slice(0, 80);
  const safeName = title ? `${title}.pdf` : filename;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);

  const contentLength = pdfRes.headers.get("content-length");
  if (contentLength) {
    res.setHeader("Content-Length", contentLength);
  }

  const reader = pdfRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}
