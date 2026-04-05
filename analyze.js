module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel Environment Variables.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); } }
  if (!body) return res.status(400).json({ error: 'Empty body.' });
  const { text, docType } = body;
  if (!text || !docType) return res.status(400).json({ error: 'Missing text or docType.' });
  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';
  let docText = text;
  if (text.length > 150000) {
    const mid = Math.floor(text.length / 2);
    docText = text.substring(0, 55000) + '\n\n[...]\n\n' + text.substring(mid - 15000, mid + 15000) + '\n\n[...]\n\n' + text.substring(text.length - 55000);
  }
  const prompt = `You are an expert procurement analyst. Analyze this ${docTypeFull} document. Return ONLY valid JSON (no markdown, no explanation) with these fields filled from the document:\n{"documentType":"${docType}","title":null,"clientOrganization":null,"projectName":null,"referenceNumber":null,"country":null,"sector":null,"fundingSource":null,"currency":null,"estimatedBudget":null,"contractDuration":null,"contractType":null,"submissionDeadline":null,"questionDeadline":null,"expectedStartDate":null,"publishedDate":null,"language":null,"eligibility":{"firmType":null,"nationality":null,"experience":null,"turnover":null,"staffRequirements":null,"certifications":null,"jointVenture":null},"selectionMethod":null,"technicalWeight":null,"financialWeight":null,"evaluationCriteria":[],"scopeSummary":null,"keyDeliverables":[],"reportingTo":null,"submissionFormat":null,"documentsRequired":[],"numberOfEnvelopes":null,"risks":[],"legalClauses":{"conflictOfInterest":null,"paymentTerms":null,"intellectualProperty":null,"disputeResolution":null,"governingLaw":null,"confidentiality":null,"forceMajeure":null,"subContracting":null},"keyHighlights":[]}\n\nDOCUMENT:\n---\n${docText}\n---`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8192, temperature: 0.1 } })
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(r.status).json({ error: e.error?.message || 'Gemini error ' + r.status }); }
    const data = await r.json();
    let raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().replace(/^```json\s*/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    try { return res.status(200).json(JSON.parse(raw)); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return res.status(200).json(JSON.parse(m[0])); }
    return res.status(500).json({ error: 'Could not parse AI response.' });
  } catch (err) { return res.status(500).json({ error: 'Server error: ' + err.message }); }
};
