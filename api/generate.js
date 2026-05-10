export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_SEARCH_KEY;
  const googleCx = process.env.GOOGLE_SEARCH_CX;

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

    // 2. Si pas de clé Google, retourner sans images
    if (!googleKey || !googleCx) {
      return res.status(200).json(claudeData);
    }

    // 3. Extraire les produits du JSON retourné
    let products = [];
    try {
      const raw = (claudeData.content || [])
        .filter(b => b.type === "text").map(b => b.text).join("").trim()
        .replace(/```json|```/g, "").trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        products = parsed.produits || [];
      }
    } catch(e) {
      // Si parse échoue, retourner sans images
      return res.status(200).json(claudeData);
    }

    // 4. Chercher une image pour chaque produit (en parallèle, max 10)
    const imagePromises = products.slice(0, 20).map(async (product) => {
      const query = encodeURIComponent(`${product.titre} ${product.marque} product`);
      try {
        const imgRes = await fetch(
          `https://www.googleapis.com/customsearch/v1?key=${googleKey}&cx=${googleCx}&q=${query}&searchType=image&num=1&imgSize=medium&safe=active`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (!imgRes.ok) return null;
        const imgData = await imgRes.json();
        return imgData.items?.[0]?.link || null;
      } catch(e) {
        return null;
      }
    });

    const images = await Promise.all(imagePromises);

    // 5. Injecter les images dans les produits
    products = products.map((p, i) => ({
      ...p,
      image_url: images[i] || null
    }));

    // 6. Reconstruire la réponse Claude avec les images ajoutées
    const originalText = (claudeData.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("").trim()
      .replace(/```json|```/g, "").trim();

    const match = originalText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        parsed.produits = products;
        const enriched = JSON.stringify(parsed);
        return res.status(200).json({
          ...claudeData,
          content: [{ type: "text", text: enriched }]
        });
      } catch(e) {}
    }

    return res.status(200).json(claudeData);

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
