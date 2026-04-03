module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY on server.' });
  }

  const { text, docType } = req.body;
  if (!text || !docType) {
    return res.status(400).json({ error: 'Missing text or docType.' });
  }

  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  const MAX_CHARS = 150000;
  let docText = text;
  if (text.length > MAX_CHARS) {
    const mid = Math.floor(text.length / 2);
    docText = text.substring(0, 55000) + '\n\n[...]\n\n' + text.substring(mid - 15000, mid + 15000) + '\n\n[...]\n\n' + text.substring(text.length - 55000);
  }

  const prompt = `You are an expert procurement analyst. Analyze this ${docTypeFull} document and extract ALL key information. Return ONLY a valid JSON object with this exact structure (use null for fields not found):

{
  "documentType": "${docType}",
  "title": "exact document title",
  "clientOrganization": "issuing organization name",
  "projectName": "project/programme name",
  "referenceNumber": "tender/reference number",
  "country": "country",
  "sector": "primary sector",
  "fundingSource": "donor/funder name",
  "currency": "currency code",
  "estimatedBudget": "budget amount or null",
  "contractDuration": "e.g. 12 months",
  "contractType": "Lump Sum / Time-Based / Retainer",
  "submissionDeadline": "exact date and time with timezone",
  "questionDeadline": "clarification questions deadline",
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
  "selectionMethod": "QCBS / QBS / FBS / LCS / CQS / SSS",
  "technicalWeight": null
