// v9 - Multi-chunk processing: every page is read, results merged
// Each chunk: ~18,000 chars = ~3,854 doc tokens + 800 prompt + 1,800 output = 6,454 total
// Well under Groq's 12,000 TPM limit. A 44k-char RFP = 3 chunks, all pages covered.

module.exports = async function handler(req, res) {

  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  // ── API key ──
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY is not set in Vercel environment variables.' });

  // ── Parse body ──
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Could not parse request body.' }); }
  }
  const { text, docType } = body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing "text" field.' });
  if (!docType || typeof docType !== 'string') return res.status(400).json({ error: 'Missing "docType" field.' });

  // ── Split document into overlapping chunks ──
  // 18,000 chars per chunk keeps each Groq call well under 12,000 tokens.
  // 500-char overlap ensures content at chunk boundaries isn't missed.
  const CHUNK_SIZE = 18000;
  const OVERLAP    = 500;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.substring(start, end));
    if (end === text.length) break;
    start = end - OVERLAP;
  }

  // ── Analyze each chunk ──
  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await analyzeChunk(apiKey, chunks[i], docType, i + 1, chunks.length);
      chunkResults.push(result);
    } catch (err) {
      return res.status(500).json({ error: `Chunk ${i + 1}/${chunks.length} failed: ${err.message}` });
    }
  }

  // ── Merge all chunk results into one complete response ──
  const merged = mergeResults(chunkResults);
  return res.status(200).json(merged);
};

// ─────────────────────────────────────────────
// Analyze a single chunk via Groq
// ─────────────────────────────────────────────
async function analyzeChunk(apiKey, chunkText, docType, chunkNum, totalChunks) {
  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  const prompt = `You are an expert procurement analyst. This is chunk ${chunkNum} of ${totalChunks} of a ${docTypeFull} document. Extract ALL information found in THIS chunk. Use null for fields not present in this chunk. Do not invent data.

Return ONLY valid JSON with this exact structure:

{"documentSummary":{"documentType":"${docType}","clientOrganization":null,"projectTitle":null,"parentProject":null,"tenderReferenceNumber":null,"issuedDate":null,"prebidQueryDeadline":null,"prebidMeetingDate":null,"prebidMeetingTime":null,"prebidMeetingVenue":null,"submissionDeadline":null,"submissionTime":null,"submissionMode":null,"submissionAddress":null,"proposalValidity":null,"contactEmail":null,"contactPhone":null},"fundingInfo":{"financingAgency":null,"loanCreditGrantNumber":null,"financingType":null,"borrower":null,"procurementRegulations":null,"currency":null,"taxTreatment":null},"proposalRequirements":{"proposalFormat":null,"contractType":null,"technicalProposalRequired":null,"financialProposalRequired":null,"jointVenturePermitted":null,"subContractingAllowed":null,"languageOfProposal":null,"numberOfCopies":null,"electronicSubmissionAllowed":null,"estimatedPersonMonths":null},"evaluationFramework":{"isQCBS":null,"selectionMethod":null,"technicalWeight":null,"financialWeight":null,"minimumTechnicalScore":null,"technicalEvaluationCriteria":[],"keyExpertSubCriteriaWeights":null,"financialScoringFormula":null},"tenderOverview":{"objective":null,"background":null,"scopeOfWork":[],"projectDuration":null,"estimatedStartDate":null,"projectLocation":null,"estimatedContractValue":null,"targetBeneficiaries":null},"teamRequirements":{"coreTeam":[],"nonCoreTeam":[],"additionalStaffNotes":null},"deliverablesAndPayments":[],"eligibilityCriteria":[],"termsAndConditions":{"liability":null,"penaltyLiquidatedDamages":null,"termination":null,"insurance":null,"indemnity":null,"conflictOfInterest":null,"paymentTerms":null,"intellectualProperty":null,"disputeResolution":null,"governingLaw":null,"confidentiality":null,"forceMajeure":null,"subContracting":null},"keyHighlights":[]}

DOCUMENT CHUNK:
---
${chunkText}
---

Return ONLY the JSON. No markdown, no code fences.`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1800,
      temperature: 0.1
    })
  });

  if (!groqRes.ok) {
    const errData = await groqRes.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Groq API status ${groqRes.status}`);
  }

  const data = await groqRes.json();
  let raw = (data.choices?.[0]?.message?.content || '').trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI returned unexpected format in chunk ' + chunkNum);
  }
}

// ─────────────────────────────────────────────
// Merge multiple chunk results into one
// Rules:
//   Scalars  → first non-null value wins
//   Arrays   → longest non-empty array wins (more items = more complete extraction)
//   Objects  → recurse
// ─────────────────────────────────────────────
function mergeResults(results) {
  if (!results || results.length === 0) return {};
  if (results.length === 1) return results[0];
  let merged = JSON.parse(JSON.stringify(results[0]));
  for (let i = 1; i < results.length; i++) {
    merged = mergeDeep(merged, results[i]);
  }
  return merged;
}

function mergeDeep(base, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;

  const result = Object.assign({}, base);

  for (const key of Object.keys(incoming)) {
    const bVal = base[key];
    const iVal = incoming[key];

    if (iVal === null || iVal === undefined) continue; // nothing to add

    if (Array.isArray(iVal)) {
      if (!Array.isArray(bVal) || bVal.length === 0) {
        // base has nothing — take incoming
        result[key] = iVal;
      } else if (iVal.length > bVal.length) {
        // incoming has more items — it's more complete
        result[key] = iVal;
      }
      // else keep base (it already has more or equal items)
    } else if (typeof iVal === 'object') {
      result[key] = mergeDeep(bVal && typeof bVal === 'object' ? bVal : {}, iVal);
    } else {
      // Scalar: keep base if it has a value, otherwise take incoming
      if (bVal === null || bVal === undefined) {
        result[key] = iVal;
      }
    }
  }

  return result;
}
