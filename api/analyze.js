// v4 - Groq with correct nested JSON structure + reduced token size
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

  // ── Truncate very large documents (Groq free tier has 12k TPM limit) ──
  const MAX_CHARS = 20000;
  let docText = text;
  if (text.length > MAX_CHARS) {
    const mid = Math.floor(text.length / 2);
    docText = text.substring(0, 8000)
      + '\n\n[...middle section omitted...]\n\n'
      + text.substring(mid - 2000, mid + 2000)
      + '\n\n[...]\n\n'
      + text.substring(text.length - 8000);
  }

  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  const prompt = `You are an expert procurement analyst. Analyze this ${docTypeFull} document and extract ALL key information. Return ONLY a valid JSON object with this exact nested structure (use null for fields not found):

{
  "documentSummary": {
    "documentType": "${docType}",
    "clientOrganization": "Full legal name of issuing client/implementing agency",
    "projectTitle": "Title of the assignment/consultancy",
    "parentProject": "Name of the larger project this falls under",
    "tenderReferenceNumber": "Full reference/tender number",
    "issuedDate": "Date document was issued",
    "prebidQueryDeadline": "Date by which written queries must be submitted",
    "prebidMeetingDate": "Date of pre-bid conference/pre-proposal meeting",
    "prebidMeetingTime": "Time of pre-bid meeting",
    "prebidMeetingVenue": "Venue or mode of pre-bid meeting",
    "submissionDeadline": "Final submission deadline date",
    "submissionTime": "Time of submission deadline",
    "submissionMode": "Hard copy / online portal / email / hybrid",
    "submissionAddress": "Physical address or portal/email for submission",
    "proposalValidity": "Number of days or date until which proposal remains valid",
    "contactEmail": "Contact email for queries",
    "contactPhone": "Contact phone"
  },
  "fundingInfo": {
    "financingAgency": "World Bank / ADB / USAID / Government / etc.",
    "loanCreditGrantNumber": "Loan/Credit/Grant number",
    "financingType": "Loan / Credit / Grant / Budget",
    "borrower": "The borrowing government entity",
    "procurementRegulations": "Which procurement regulations apply",
    "currency": "Currency for financial proposal",
    "taxTreatment": "How taxes are handled"
  },
  "proposalRequirements": {
    "proposalFormat": "Full Technical Proposal / Simplified Technical Proposal",
    "contractType": "Lump-Sum / Time-Based / Retainer",
    "technicalProposalRequired": true,
    "financialProposalRequired": true,
    "jointVenturePermitted": null,
    "subContractingAllowed": null,
    "languageOfProposal": "English",
    "numberOfCopies": "Original + N copies or electronic submission",
    "electronicSubmissionAllowed": null,
    "estimatedPersonMonths": "Total person-months of key expert input estimated"
  },
  "evaluationFramework": {
    "isQCBS": null,
    "selectionMethod": "QCBS / QBS / FBS / LCS / CQS",
    "technicalWeight": null,
    "financialWeight": null,
    "minimumTechnicalScore": null,
    "technicalEvaluationCriteria": [
      {
        "criterionNumber": "i",
        "criterion": "criterion name",
        "maxScore": null,
        "description": "brief description",
        "subCriteria": [
          {"name": "sub-criterion name", "score": null}
        ]
      }
    ],
    "keyExpertSubCriteriaWeights": "Description of how key expert scores are broken down",
    "financialScoringFormula": "How financial score is calculated"
  },
  "tenderOverview": {
    "objective": "Clear 2-3 sentence statement of the assignment objective",
    "background": "Brief background on the program/project context",
    "scopeOfWork": ["Major activity or deliverable 1", "Major activity or deliverable 2"],
    "projectDuration": "Duration in months or years as stated",
    "estimatedStartDate": "Anticipated start date",
    "projectLocation": "Where the work will be performed",
    "estimatedContractValue": "Budget or indicative contract value if mentioned",
    "targetBeneficiaries": "Who benefits from this project"
  },
  "teamRequirements": {
    "coreTeam": [
      {
        "positionCode": "K-1",
        "position": "Position title",
        "isKeyExpert": true,
        "numberOfPositions": 1,
        "personMonths": null,
        "commitmentLevel": "Full-time / Part-time / Periodic",
        "educationalQualification": "Required education",
        "yearsOfExperience": "Minimum years",
        "specificExperience": "Specific experience required",
        "evaluationScore": null
      }
    ],
    "nonCoreTeam": [
      {
        "positionCode": "N-1",
        "position": "Position title",
        "isKeyExpert": false,
        "numberOfPositions": 1,
        "personMonths": null,
        "commitmentLevel": "Periodic",
        "educationalQualification": "Required education",
        "yearsOfExperience": "Minimum years",
        "specificExperience": "Specific experience required"
      }
    ],
    "additionalStaffNotes": "Any notes on field staff, language requirements, gender requirements"
  },
  "deliverablesAndPayments": [
    {
      "deliverableNo": 1,
      "deliverableName": "Deliverable name",
      "timeline": "Timeline as stated",
      "paymentPercentage": "Payment percentage",
      "description": "Brief description"
    }
  ],
  "eligibilityCriteria": [
    "Specific eligibility requirement 1",
    "Specific eligibility requirement 2"
  ],
  "termsAndConditions": {
    "liability": "Summary of liability limitations",
    "penaltyLiquidatedDamages": "Penalty/LD rates and conditions",
    "termination": "Termination conditions",
    "insurance": "Required insurance types",
    "indemnity": "Indemnity provisions",
    "conflictOfInterest": "COI restrictions",
    "paymentTerms": "Payment basis and timeline",
    "intellectualProperty": "Ownership of deliverables and data",
    "disputeResolution": "Arbitration / Court details",
    "governingLaw": "Applicable law/jurisdiction",
    "confidentiality": "Confidentiality obligations",
    "forceMajeure": "Force majeure definition",
    "subContracting": "Rules on sub-contracting"
  },
  "keyHighlights": [
    "Important requirement or flag bidders must note",
    "Another critical item"
  ]
}

DOCUMENT TO ANALYZE:
---
${docText}
---

Return ONLY the JSON object. No markdown, no explanation, no code fences.`;

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
          max_tokens: 4096,
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
