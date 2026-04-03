// Vercel Serverless Function — /api/analyze
// The GEMINI_API_KEY lives in Vercel's Environment Variables, never in the browser.

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing GEMINI_API_KEY. Add it in Vercel → Project Settings → Environment Variables.'
    });
  }

  const { text, docType } = req.body;
  if (!text || !docType) {
    return res.status(400).json({ error: 'Missing text or docType in request body.' });
  }

  const docTypeFull = docType === 'EOI'
    ? 'Expression of Interest (EoI)'
    : 'Request for Proposal (RfP)';

  // Truncate very large documents
  const MAX_CHARS = 150000;
  let docText = text;
  if (text.length > MAX_CHARS) {
    const c1  = text.substring(0, 55000);
    const mid = Math.floor(text.length / 2);
    const c2  = text.substring(mid - 15000, mid + 15000);
    const c3  = text.substring(text.length - 55000);
    docText   = c1 + '\n\n[...middle section...]\n\n' + c2 + '\n\n[...]\n\n' + c3;
  }

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
  "contractType": "e.g. Lump Sum / Time-Based / Retainer",
  "submissionDeadline": "exact date and time with timezone",
  "questionDeadline": "deadline to submit clarification questions",
  "expectedStartDate": "project start date",
  "publishedDate": "date document was issued",
  "language": "submission language",
  "eligibility": {
    "firmType": "who can apply: individual/firm/consortium/NGO/etc.",
    "nationality": "nationality restrictions if any",
    "experience": "minimum years or specific past project requirements",
    "turnover": "minimum annual turnover requirement",
    "staffRequirements": "key personnel required",
    "certifications": "required certifications or accreditations",
    "jointVenture": "JV/consortium rules"
  },
  "selectionMethod": "QCBS / QBS / FBS / LCS / CQS / SSS / other",
  "technicalWeight": null,
  "financialWeight": null,
  "evaluationCriteria": [
    { "criterion": "criterion name", "weight": null, "subCriteria": ["sub1","sub2"] }
  ],
  "scopeSummary": "2-3 sentence summary of what the consultant must do",
  "keyDeliverables": ["deliverable 1", "deliverable 2"],
  "reportingTo": "who the consultant reports to",
  "submissionFormat": "how to submit: email/portal/physical/etc.",
  "documentsRequired": ["document 1", "document 2"],
  "numberOfEnvelopes": "single / two-envelope / other",
  "risks": [
    { "risk": "risk description", "severity": "High/Medium/Low" }
  ],
  "legalClauses": {
    "conflictOfInterest": "COI restrictions",
    "paymentTerms": "payment basis and timeline",
    "intellectualProperty": "ownership of deliverables",
    "disputeResolution": "arbitration/court details",
    "governingLaw": "applicable law/jurisdiction",
    "confidentiality": "confidentiality obligations",
    "forceMajeure": "force majeure definition",
    "subContracting": "sub-contracting rules"
  },
  "keyHighlights": [
    "Important requirement or flag bidders must note"
  ]
}

DOCUMENT TO ANALYZE:
---
${docText}
---

Return ONLY the JSON object. No markdown, no explanation.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.1 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      const msg = errData.error?.message || `Gemini API error ${geminiRes.status}`;
      return res.status(geminiRes.status).json({ error: msg });
    }

    const data = await geminiRes.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else return res.status(500).json({ error: 'Could not parse AI response. Please try again.' });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
