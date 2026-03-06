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
    `?select=id,pdf_path,manuscript_title,author_name,institution,discipline,created_at,viscosity` +
    `&id=eq.${id}`;

  const metaRes = await fetch(metaUrl, {
    headers: { apikey: API_KEY, "Content-Type": "application/json" },
  });
  if (!metaRes.ok) {
    return res.status(502).json({ error: "Supabase query failed" });
  }

  const rows = await metaRes.json();
  if (!rows.length) {
    return res.status(404).json({ error: "Preprint not found" });
  }

  const row = rows[0];
  if (!row.pdf_path) {
    return res.status(404).json({ error: "No PDF available for this preprint" });
  }

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

  res.json({
    id: row.id,
    title: row.manuscript_title,
    author: row.author_name,
    institution: row.institution,
    discipline: row.discipline,
    viscosity: row.viscosity,
    created_at: row.created_at,
    pdf_path: row.pdf_path,
    filename: row.pdf_path.split("/").pop(),
    download_url: downloadUrl,
  });
}
