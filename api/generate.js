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
    const count = req.body?.messages?.[0]?.content?.match(/Identifie (\d+)/)?.[1] || "15";
    const today = new Date().toLocaleDateString("fr-CA", { month: "long", year: "numeric" });

    // Sources spécialisées de Stéphane
    const SOURCES = [
      "site:bevindustry.com new beverage launch 2026",
      "site:beveragedaily.com new drink product 2026",
      "site:fooddive.com new beverage launch 2026",
      "site:just-drinks.com new product launch 2026",
      "site:bevnet.com new product 2026",
      "site:sodaspectrum.com new soda 2026",
      "new snack food candy launch USA Canada 2026",
      "new beverage drink launch North America 2026"
    ];

    let webContext = "";
    if (serperKey) {
      const searchPromises = SOURCES.map(async (q) => {
        try {
          const r = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q, num: 5, gl: "us" }),
            signal: AbortSignal.timeout(5000)
          });
          if (!r.ok) return "";
          const d = await r.json();
          return (d.organic || []).slice(0, 3).map(i =>
            `[${i.link}] ${i.title}: ${i.snippet}`
          ).join("\n");
        } catch(e) { return ""; }
      });

      const results = await Promise.all(searchPromises);
      webContext = results.filter(Boolean).join("\n\n");
    }

    // Générer avec Claude + contexte web
    const prompt = `Tu es un expert en veille de marché pour les épiceries fines nord-américaines.

${webContext ? `Voici des informations RÉCENTES (2025-2026) extraites de sources spécialisées :\n\n${webContext}\n\n` : ""}

En te basant sur ces informations récentes, identifie ${count} vraies nouveautés (priorité absolue aux lancements 2025-2026) du marché alimentaire nord-américain : boissons, snacks, épicerie, tendances.

Ces produits sont pour Canadian American Market, épicerie fine à Vevey et Genève Eaux-Vives, Suisse.

Réponds UNIQUEMENT avec JSON valide sans backticks :
{"edition":"${today}","produits":[{"titre":"Nom","marque":"Marque","pays":"Canada ou USA","categorie":"boissons","date_lancement":"saison année","description":"2-3 phrases en français","interet":"1 phrase pour Genève/Vevey","source":"nom du site source"}]}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json(err);
    }

    const claudeData = await claudeRes.json();

    // Parser les produits
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

    // Images via Serper
    if (serperKey && products.length) {
      const imagePromises = products.map(async (product) => {
        try {
          const imgRes = await fetch("https://google.serper.dev/images", {
            method: "POST",
            headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: `${product.titre} ${product.marque} product packaging`, num: 3 }),
            signal: AbortSignal.timeout(5000)
          });
          if (!imgRes.ok) return null;
          const imgData = await imgRes.json();
          const images = imgData.images || [];
          for (const img of images) {
            if (img.imageUrl && img.imageUrl.match(/\.(jpg|jpeg|png|webp)/i)) return img.imageUrl;
          }
          return images[0]?.imageUrl || null;
        } catch(e) { return null; }
      });

      const imageUrls = await Promise.all(imagePromises);
      parsedEdition.produits = products.map((p, i) => ({ ...p, image_url: imageUrls[i] || null }));
    }

    return res.status(200).json({
      ...claudeData,
      content: [{ type: "text", text: JSON.stringify(parsedEdition) }]
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
