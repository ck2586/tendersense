// v12 — Full-document chunked extraction with:
//   - Explicit schema examples for ALL array types (criteria, deliverables, team, scope)
//   - Detailed scopeOfWork: "Component N: Title — sub-item1; sub-item2" format
//   - Combine-merge for arrays that span multiple pages/chunks
//   - 2400 max_tokens per chunk, 15000-char chunks, 8s inter-chunk delay
//   - Retry with Groq-reported wait time on rate-limit errors

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY is not set in Vercel environment variables.' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Could not parse request body.' }); }
  }
  const { text, docType } = body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing "text" field.' });
  if (!docType || typeof docType !== 'string') return res.status(400).json({ error: 'Missing "docType" field.' });

  // Chunk the document — 15,000 chars ≈ 3,200 tokens input.
  // 2,400 max_tokens output → ~5,600 total per request.
  // After 8s delay, 12,000 TPM window clears ~1,600 tokens, so chunk 2 fits.
  const CHUNK_SIZE = 15000;
  const OVERLAP    = 500;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.substring(start, end));
    if (end === text.length) break;
    start = end - OVERLAP;
  }

  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(8000);
    let attempts = 0;
    while (true) {
      try {
        const result = await analyzeChunk(apiKey, chunks[i], docType, i + 1, chunks.length);
        chunkResults.push(result);
        break;
      } catch (err) {
        attempts++;
        const waitMs = parseRetryAfter(err.message);
        if (attempts < 3 && waitMs > 0) {
          await sleep(waitMs + 500);
        } else {
          return res.status(500).json({ error: `Chunk ${i + 1}/${chunks.length} failed after ${attempts} attempts: ${err.message}` });
        }
      }
    }
  }

  const merged = mergeResults(chunkResults);
  return res.status(200).json(merged);
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryAfter(message) {
  const m = (message || '').match(/try again in (\d+\.?\d*)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 5000;
}

async function analyzeChunk(apiKey, chunkText, docType, chunkNum, totalChunks) {
  const docTypeFull = docType === 'EOI' ? 'Expression of Interest (EoI)' : 'Request for Proposal (RfP)';

  const prompt = `You are an expert procurement analyst. This is chunk ${chunkNum} of ${totalChunks} of a ${docTypeFull} document. Extract ALL information found in THIS chunk. Return null for fields absent in this chunk. Do NOT invent or guess data.

EXTRACTION RULES — READ CAREFULLY:

1. technicalEvaluationCriteria: Extract EVERY main criterion AND its sub-criteria with EXACT point allocations. Include criterionNumber (e.g. "1", "1.1", "2.2"), full criterion name, a concise description, maxScore as an integer, and all subCriteria with their name and score.

2. deliverablesAndPayments: Extract EVERY deliverable row with its COMPLETE name (e.g. "Inception Report detailing refined methodology and approach"), the exact timeline (e.g. "2 weeks from contract signing"), and the payment percentage/tranche (e.g. "10%").

3. coreTeam: Extract each expert position. Use the position title (e.g. "Team Lead", "Gender Analyst"), qualifications required, years of experience, and the evaluationScore (points allocated to that position in the evaluation criteria).

4. scopeOfWork: Extract DETAILED scope, NOT just component titles. For each component include all its sub-deliverables in this format: "Component N: [Title] — [sub-item 1]; [sub-item 2]; [sub-item 3]". Example: "Component 1: Mapping of Gender-Specific Indicators — Gender indicator gap analysis report for two states; Enhanced gender-responsive indicator set; Priority indicators with multiplier effect analysis; Indicator metadata sheets".

5. minimumTechnicalScore: Extract as a whole number (e.g. 70, not 0.7). If the document says "70%", extract 70.

Return ONLY valid JSON with this exact structure (array items show required schema — replace with real data):

{"documentSummary":{"documentType":"${docType}","clientOrganization":null,"projectTitle":null,"parentProject":null,"tenderReferenceNumber":null,"issuedDate":null,"prebidQueryDeadline":null,"prebidMeetingDate":null,"prebidMeetingTime":null,"prebidMeetingVenue":null,"submissionDeadline":null,"submissionTime":null,"submissionMode":null,"submissionAddress":null,"proposalValidity":null,"contactEmail":null,"contactPhone":null},"fundingInfo":{"financingAgency":null,"loanCreditGrantNumber":null,"financingType":null,"borrower":null,"procurementRegulations":null,"currency":null,"taxTreatment":null},"proposalRequirements":{"proposalFormat":null,"contractType":null,"technicalProposalRequired":null,"financialProposalRequired":null,"jointVenturePermitted":null,"subContractingAllowed":null,"languageOfProposal":null,"numberOfCopies":null,"electronicSubmissionAllowed":null,"estimatedPersonMonths":null},"evaluationFramework":{"isQCBS":null,"selectionMethod":null,"technicalWeight":null,"financialWeight":null,"minimumTechnicalScore":null,"technicalEvaluationCriteria":[{"criterionNumber":"1","criterion":"Expertise of the Firm","description":"Track record and organisational credentials","maxScore":20,"subCriteria":[{"name":"1.1 Years of experience in gender mainstreaming","score":5},{"name":"1.2 Proven experience in two areas","score":8},{"name":"1.3 State government engagement experience","score":7}]}],"keyExpertSubCriteriaWeights":null,"financialScoringFormula":null},"tenderOverview":{"objective":null,"background":null,"scopeOfWork":["Component 1: Title — sub-deliverable A; sub-deliverable B; sub-deliverable C","Component 2: Title — sub-deliverable A; sub-deliverable B"],"projectDuration":null,"estimatedStartDate":null,"projectLocation":null,"estimatedContractValue":null,"targetBeneficiaries":null},"teamRequirements":{"coreTeam":[{"positionCode":"2.1","position":"Team Lead","educationalQualification":"Master's degree in public policy or related discipline","specificExperience":"At least 10 years progressive professional experience in gender mainstreaming","personMonths":null,"numberOfPositions":1,"evaluationScore":10}],"nonCoreTeam":[],"additionalStaffNotes":null},"deliverablesAndPayments":[{"deliverableNo":1,"deliverableName":"Inception Report detailing refined methodology, approach, workplan, stakeholder mapping and risk register","description":null,"timeline":"2 weeks from contract signing","paymentPercentage":"10%"}],"eligibilityCriteria":[],"termsAndConditions":{"liability":null,"penaltyLiquidatedDamages":null,"termination":null,"insurance":null,"indemnity":null,"conflictOfInterest":null,"paymentTerms":null,"intellectualProperty":null,"disputeResolution":null,"governingLaw":null,"confidentiality":null,"forceMajeure":null,"subContracting":null},"keyHighlights":[]}

Replace ALL example values above with real data from this chunk. Return [] for array fields with no data in this chunk.

DOCUMENT CHUNK:
---
${chunkText}
---

Return ONLY the JSON object. No markdown, no code fences, no commentary.`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2400,
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

// ─────────────────────────────────────────────────────────────
// Merge Strategy
//   COMBINE arrays — concatenate + deduplicate across chunks
//     (criteria, deliverables, team, scope, eligibility, highlights)
//   BEST-WINS arrays — pick array with most real data
//   Scalars — first non-null wins
//   Objects — recurse
// ─────────────────────────────────────────────────────────────

const COMBINE_ARRAYS = new Set([
  'technicalEvaluationCriteria',
  'deliverablesAndPayments',
  'scopeOfWork',
  'eligibilityCriteria',
  'keyHighlights',
  'coreTeam',
  'nonCoreTeam'
]);

function mergeResults(results) {
  if (!results || results.length === 0) return {};
  if (results.length === 1) return results[0];
  let merged = JSON.parse(JSON.stringify(results[0]));
  for (let i = 1; i < results.length; i++) {
    merged = mergeDeep(merged, results[i]);
  }
  return merged;
}

function countData(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.reduce((sum, item) => {
    if (item === null || item === undefined) return sum;
    if (typeof item === 'string') return sum + (item.trim().length > 0 ? 1 : 0);
    if (typeof item === 'object') {
      return sum + Object.values(item).filter(
        v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
      ).length;
    }
    return sum + 1;
  }, 0);
}

function mergeArrayCombine(baseArr, incomingArr) {
  if (!Array.isArray(baseArr)) baseArr = [];
  if (!Array.isArray(incomingArr) || incomingArr.length === 0) return baseArr;

  const combined = baseArr.slice();

  for (const item of incomingArr) {
    if (item === null || item === undefined) continue;

    if (typeof item === 'string') {
      if (item.trim() && !combined.some(x => x === item)) combined.push(item);
      continue;
    }

    if (typeof item !== 'object') { combined.push(item); continue; }

    const dedupKey = item.criterionNumber ?? item.deliverableNo ?? item.positionCode ?? item.position ?? null;

    if (dedupKey !== null && dedupKey !== undefined && dedupKey !== '') {
      const existingIdx = combined.findIndex(x =>
        typeof x === 'object' && x !== null &&
        (x.criterionNumber === dedupKey || x.deliverableNo === dedupKey ||
         x.positionCode === dedupKey || x.position === dedupKey)
      );
      if (existingIdx >= 0) {
        if (countData([item]) > countData([combined[existingIdx]])) {
          combined[existingIdx] = item;
        }
      } else {
        if (countData([item]) > 0) combined.push(item);
      }
    } else {
      if (countData([item]) > 0) combined.push(item);
    }
  }
  return combined;
}

function mergeDeep(base, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
  const result = Object.assign({}, base);

  for (const key of Object.keys(incoming)) {
    const bVal = base[key];
    const iVal = incoming[key];
    if (iVal === null || iVal === undefined) continue;

    if (Array.isArray(iVal)) {
      if (COMBINE_ARRAYS.has(key)) {
        result[key] = mergeArrayCombine(Array.isArray(bVal) ? bVal : [], iVal);
      } else if (!Array.isArray(bVal) || bVal.length === 0) {
        result[key] = iVal;
      } else {
        if (countData(iVal) > countData(bVal)) result[key] = iVal;
      }
    } else if (typeof iVal === 'object') {
      result[key] = mergeDeep(bVal && typeof bVal === 'object' ? bVal : {}, iVal);
    } else {
      if (bVal === null || bVal === undefined) result[key] = iVal;
    }
  }
  return result;
}
