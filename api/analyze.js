// v2 - Groq
// TenderSense — Vercel Serverless Function
// POST /api/analyze  { text: string, docType: "EOI"|"RFP" }

module.exports = async function handler(req, res) {

  // ── CORS headers ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ── API key check ──
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GROQ_API_KEY is not set. Go to Vercel → Project Settings → Environment Variables, add the key, then redeploy.'
    });
  }

  // ── Parse body ──
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Could not parse request body as JSON.' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body is empty or invalid.' });
  }

  const { text, docType } = body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "text" field in request.' });
  }
  if (!docType || typeof docType !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "docType" field in request.' });
  }

  // ── Truncate very large documents ──
  const MAX_CHARS = 80000;
  let docText = text;
  if (text.length > MAX_CHARS) {
    const mid = Math.floor(text.length / 2);
    docText = text.substring(0, 30000)
      + '\n\n[...middle section omitted...]\n\n'
      + text.substring(mid - 10000, mid + 10000)
      + '\n\n[...]\n\n'
      + text.substring(text.length - 30000);
  }

  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  const prompt = `You are an expert procurement analyst. Analyze this ${docTypeFull} document and extract ALL key information. Return ONLY a valid JSON object with this exact structure (use null for fields not found):

{
  "documentType": "${docType}",
  "title": "exact document title",
  "clientOrganization": "issuing organization name",
  "projectName": "project/programme name",
  "referenceNumber": "tender/reference number",
  "country": "country",
  "sector": "primary sector (Health/Education/Agriculture/etc.)",
  "fundingSource": "donor/funder name",
  "currency": "currency code (USD/EUR/etc.)",
  "estimatedBudget": "budget amount as string or null",
  "contractDuration": "e.g. 12 months",
  "contractType": "Lump Sum / Time-Based / Retainer",
  "submissionDeadline": "exact date and time with timezone",
  "questionDeadline": "deadline to submit clarification questions",
  "expectedStartDate": "project start date",
  "publishedDate": "date document was issued",
  "language": "submission language",
  "eligibility": {
    "firmType": "individual/firm/consortium/NGO",
    "nationality": "nationality restrictions",
    "experience": "minimum experience requirements",
    "turnover": "minimum annual turnover",
    "staffRequirements": "key personnel required",
    "certifications": "required certifications",
    "jointVenture": "JV/consortium rules"
  },
  "selectionMethod": "QCBS / QBS / FBS / LCS / CQS / SSS / other",
  "technicalWeight": null,
  "financialWeight": null,
  "evaluationCriteria": [
    { "criterion": "criterion name", "weight": null, "subCriteria": ["sub1", "sub2"] }
  ],
  "scopeSummary": "2-3 sentence summary of what the consultant must do",
  "keyDeliverables": ["deliverable 1", "deliverable 2"],
  "reportingTo": "who the consultant reports to",
  "submissionFormat": "email/portal/physical",
  "documentsRequired": ["document 1", "document 2"],
  "numberOfEnvelopes": "single / two-envelope",
  "risks": [
    { "risk": "risk description", "severity": "High/Medium/Low" }
  ],
  "legalClauses": {
    "conflictOfInterest": "COI restrictions",
    "paymentTerms": "payment basis and timeline",
    "intellectualProperty": "ownership of deliverables",
    "disputeResolution": "arbitration/court details",
    "governingLaw": "applicable jurisdiction",
    "confidentiality": "confidentiality obligations",
    "forceMajeure": "force majeure definition",
    "subContracting": "sub-contracting rules"
  },
  "keyHighlights": ["important requirement or flag"]
}

DOCUMENT TO ANALYZE:
---
${docText}
---

Return ONLY the JSON object. No markdown, no explanation.`;

  // ── Call Groq ──
  try {
    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 8192,
          temperature: 0.1
        })
      }
    );

    if (!groqRes.ok) {
      const errData = await groqRes.json().catch(() => ({}));
      const msg = errData.error?.message || `Groq API returned status ${groqRes.status}`;
      return res.status(groqRes.status).json({ error: msg });
    }

    const data = await groqRes.json();
    let raw = (data.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    try {
      return res.status(200).json(JSON.parse(raw));
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { return res.status(200).json(JSON.parse(m[0])); }
        catch { /* fall through */ }
      }
      return res.status(500).json({ error: 'AI returned an unexpected format. Please try again.' });
    }

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || String(err)) });
  }
};
