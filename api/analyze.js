// v8 - Tuned to actual token density (4.67 chars/token): 34k doc + max_tokens=2000 = ~9800 total
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

  // ── Document coverage (calibrated from real error data) ──
  // Observed: 44,000 char doc = 9,434 tokens → 4.67 chars/token for this doc type.
  // Budget: 12,000 TPM limit (Groq counts input + max_tokens combined).
  //   Prompt ≈ 800 tokens + doc ≈ 7,281 tokens + max_tokens 2,000 = 10,081 total ✓
  // HEAD covers pages 1–14 (all substantive content incl. evaluation criteria).
  // TAIL covers final pages (terms, payment, submission instructions).
  const HEAD_CHARS = 28000; // pages 1–14 at ~2,000 chars/page
  const TAIL_CHARS = 6000;  // last ~3 pages
  const MAX_CHARS  = HEAD_CHARS + TAIL_CHARS; // 34,000 chars

  let docText = text;
  if (text.length > MAX_CHARS) {
    docText = text.substring(0, HEAD_CHARS)
      + '\n\n[...appendix forms omitted...]\n\n'
      + text.substring(text.length - TAIL_CHARS);
  }

  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  // Compact prompt — field names only (no descriptions), saves ~2,000 tokens vs verbose version
  const prompt = `You are an expert procurement analyst. Extract ALL information from this ${docTypeFull}. Return ONLY valid JSON matching this exact structure. Use null for any field not found. Do not invent data.

{"documentSummary":{"documentType":"${docType}","clientOrganization":null,"projectTitle":null,"parentProject":null,"tenderReferenceNumber":null,"issuedDate":null,"prebidQueryDeadline":null,"prebidMeetingDate":null,"prebidMeetingTime":null,"prebidMeetingVenue":null,"submissionDeadline":null,"submissionTime":null,"submissionMode":null,"submissionAddress":null,"proposalValidity":null,"contactEmail":null,"contactPhone":null},"fundingInfo":{"financingAgency":null,"loanCreditGrantNumber":null,"financingType":null,"borrower":null,"procurementRegulations":null,"currency":null,"taxTreatment":null},"proposalRequirements":{"proposalFormat":null,"contractType":null,"technicalProposalRequired":null,"financialProposalRequired":null,"jointVenturePermitted":null,"subContractingAllowed":null,"languageOfProposal":null,"numberOfCopies":null,"electronicSubmissionAllowed":null,"estimatedPersonMonths":null},"evaluationFramework":{"isQCBS":null,"selectionMethod":null,"technicalWeight":null,"financialWeight":null,"minimumTechnicalScore":null,"technicalEvaluationCriteria":[{"criterionNumber":null,"criterion":null,"maxScore":null,"description":null,"subCriteria":[{"name":null,"score":null}]}],"keyExpertSubCriteriaWeights":null,"financialScoringFormula":null},"tenderOverview":{"objective":null,"background":null,"scopeOfWork":[],"projectDuration":null,"estimatedStartDate":null,"projectLocation":null,"estimatedContractValue":null,"targetBeneficiaries":null},"teamRequirements":{"coreTeam":[{"positionCode":null,"position":null,"isKeyExpert":true,"numberOfPositions":null,"personMonths":null,"commitmentLevel":null,"educationalQualification":null,"yearsOfExperience":null,"specificExperience":null,"evaluationScore":null}],"nonCoreTeam":[{"positionCode":null,"position":null,"isKeyExpert":false,"numberOfPositions":null,"personMonths":null,"commitmentLevel":null,"educationalQualification":null,"yearsOfExperience":null,"specificExperience":null}],"additionalStaffNotes":null},"deliverablesAndPayments":[{"deliverableNo":1,"deliverableName":null,"timeline":null,"paymentPercentage":null,"description":null}],"eligibilityCriteria":[],"termsAndConditions":{"liability":null,"penaltyLiquidatedDamages":null,"termination":null,"insurance":null,"indemnity":null,"conflictOfInterest":null,"paymentTerms":null,"intellectualProperty":null,"disputeResolution":null,"governingLaw":null,"confidentiality":null,"forceMajeure":null,"subContracting":null},"keyHighlights":[]}

DOCUMENT:
---
${docText}
---

Return ONLY the JSON. No markdown, no code fences.`;

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
          max_tokens: 2000,
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
