export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "API key not configured" });

  try {
    // 1. Générer les produits avec Claude
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(req.body)
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json(err);
    }

    const claudeData = await claudeRes.json();
    if (!serperKey) return res.status(200).json(claudeData);

    // 2. Parser les produits
    let products = [];
    let parsedEdition = {};
    try {
      const raw = (claudeData.content || [])
        .filter(b => b.type === "text").map(b => b.text).join("").trim()
        .replace(/```json|```/g, "").trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsedEdition = JSON.parse(match[0]);
        products = parsedEdition.produits || [];
      }
    } catch(e) {
      return res.status(200).json(claudeData);
    }

    // 3. Chercher images via Serper en parallèle
    const imagePromises = products.map(async (product) => {
      const query = `${product.titre} ${product.marque} product packaging`;
      try {
        const imgRes = await fetch("https://google.serper.dev/images", {
          method: "POST",
          headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, num: 3 }),
          signal: AbortSignal.timeout(5000)
        });
        if (!imgRes.ok) return null;
        const imgData = await imgRes.json();
        const images = imgData.images || [];
        for (const img of images) {
          if (img.imageUrl && img.imageUrl.match(/\.(jpg|jpeg|png|webp)/i)) {
            return img.imageUrl;
          }
        }
        return images[0]?.imageUrl || null;
      } catch(e) { return null; }
    });

    const imageUrls = await Promise.all(imagePromises);

    parsedEdition.produits = products.map((p, i) => ({
      ...p,
      image_url: imageUrls[i] || null
    }));

    return res.status(200).json({
      ...claudeData,
      content: [{ type: "text", text: JSON.stringify(parsedEdition) }]
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
