import { initializeApp, getApps } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: "canadian-american-stock.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "canadian-american-stock"
};

function getFirebaseDb() {
  try {
    const app = getApps().find(a => a.name === "mw") ||
      initializeApp(firebaseConfig, "mw");
    return getFirestore(app);
  } catch(e) { return null; }
}

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

    // 1. Récupérer la date du dernier journal depuis Firebase
    let lastDate = null;
    let seenTitles = [];
    const db = getFirebaseDb();
    if (db) {
      try {
        const snap = await getDoc(doc(db, "market_watch_meta", "last_journal"));
        if (snap.exists()) {
          lastDate = snap.data().date;
          seenTitles = snap.data().titles || [];
        }
      } catch(e) {}
    }

    const sinceText = lastDate
      ? `Cherche UNIQUEMENT les produits lancés ou annoncés APRÈS le ${lastDate}. Ne répète pas ces produits déjà vus : ${seenTitles.slice(0,20).join(", ")}.`
      : "Cherche les produits les plus récents de 2025-2026.";

    // 2. Recherche web via Serper sur les sources spécialisées
    const SOURCES = [
      "site:bevindustry.com new beverage launch 2026",
      "site:beveragedaily.com new drink product 2026",
      "site:fooddive.com new beverage launch 2026",
      "site:just-drinks.com new product launch 2026",
      "site:bevnet.com new product 2026",
      "site:sodaspectrum.com new soda 2026",
      "new snack food launch USA Canada 2026",
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

    // 3. Générer avec Claude
    const prompt = `Tu es un expert en veille de marché pour les épiceries fines nord-américaines.

${webContext ? `Informations récentes trouvées sur le web :\n\n${webContext}\n\n` : ""}

${sinceText}

Identifie le MAXIMUM de vraies nouveautés récentes du marché alimentaire nord-américain (boissons, snacks, épicerie, tendances) — sans limite de nombre, remonte tout ce qui est nouveau depuis la dernière recherche.

Ces produits sont pour Canadian American Market, épicerie fine à Vevey et Genève Eaux-Vives, Suisse.

Réponds UNIQUEMENT avec JSON valide sans backticks :
{"edition":"${today}","produits":[{"titre":"Nom","marque":"Marque","pays":"Canada ou USA","categorie":"boissons","date_lancement":"saison année","description":"2-3 phrases en français","interet":"1 phrase pour Genève/Vevey","source":"nom site source"}]}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      return res.status(claudeRes.status).json(err);
    }

    const claudeData = await claudeRes.json();

    // 4. Parser les produits
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

    // 5. Images via Serper
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

    // 6. Sauvegarder la date et les titres dans Firebase
    if (db && products.length) {
      try {
        const nowStr = new Date().toLocaleDateString("fr-CA", { day:"numeric", month:"long", year:"numeric" });
        const newTitles = [...seenTitles, ...products.map(p => p.titre)].slice(-100);
        await setDoc(doc(db, "market_watch_meta", "last_journal"), {
          date: nowStr,
          titles: newTitles,
          count: products.length,
          updatedAt: new Date().toISOString()
        });
        // Sauvegarder l'édition complète
        await addDoc(collection(db, "market_watch_journals"), {
          ...parsedEdition,
          timestamp: Date.now(),
          dateStr: new Date().toLocaleDateString("fr-CA", { weekday:"long", day:"numeric", month:"long", year:"numeric" })
        });
      } catch(e) {}
    }

    parsedEdition.last_search_date = lastDate;

    return res.status(200).json({
      ...claudeData,
      content: [{ type: "text", text: JSON.stringify(parsedEdition) }]
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
