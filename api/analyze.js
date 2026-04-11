// v7 - Compact prompt (~800 tokens vs 2840) + 44k doc coverage + max_tokens=3000
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

  // ── Document coverage ──
  // Budget: Groq free tier = 12,000 tokens/min (input + output combined).
  // Compact prompt below ≈ 800 tokens. max_tokens output = 3,000.
  // Remaining for document text: 12,000 - 800 - 3,000 = 8,200 tokens ≈ 44,000 chars.
  // This covers the ENTIRE Odisha-style RFP (22 pages, ~44k chars) with no truncation.
  // For larger docs we take a long head (all substantive sections) + tail (final terms).
  const HEAD_CHARS = 36000;
  const TAIL_CHARS = 8000;
  const MAX_CHARS  = HEAD_CHARS + TAIL_CHARS; // 44,000 chars

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
          max_tokens: 3000,
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
