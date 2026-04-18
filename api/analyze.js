// v13 — Rate limit hardening on top of v12:
//   - Inter-chunk delay increased 8s → 12s (handles 5-6 chunk documents)
//   - Max retry attempts increased 3 → 5
//   - Retry buffer increased 500ms → 1000ms after Groq-reported wait time
//   - All v12 features retained:
//       Explicit schema examples for all array types
//       Detailed scopeOfWork "Component N: Title — sub-items" format
//       Combine-merge + post-merge cleanup (dedup scope, filter promoted sub-criteria)
//       2400 max_tokens per chunk, 15000-char chunks

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
    if (i > 0) await sleep(12000);
    let attempts = 0;
    while (true) {
      try {
        const result = await analyzeChunk(apiKey, chunks[i], docType, i + 1, chunks.length);
        chunkResults.push(result);
        break;
      } catch (err) {
        attempts++;
        const waitMs = parseRetryAfter(err.message);
        if (attempts < 5 && waitMs > 0) {
          await sleep(waitMs + 1000);
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
  if (results.length === 1) return cleanupMerged(results[0]);
  let merged = JSON.parse(JSON.stringify(results[0]));
  for (let i = 1; i < results.length; i++) {
    merged = mergeDeep(merged, results[i]);
  }
  return cleanupMerged(merged);
}

// ─────────────────────────────────────────────────────────────
// Post-merge cleanup — fixes two multi-chunk artefacts:
//
//  1. scopeOfWork duplicates: same component extracted from
//     multiple chunks with slightly different wording.
//     Strategy: keep ONE entry per "Component N" — the longest
//     (most detailed) string wins.
//
//  2. Promoted sub-criteria: a sub-criterion like "3.2" may
//     appear both inside criterion "3".subCriteria AND as a
//     separate top-level entry (from a different chunk).
//     Strategy: remove any top-level criterion whose number
//     contains a "." AND whose parent number already exists.
// ─────────────────────────────────────────────────────────────
function cleanupMerged(data) {
  // --- 1. Deduplicate scopeOfWork by component number ----------
  const sow = data && data.tenderOverview && data.tenderOverview.scopeOfWork;
  if (Array.isArray(sow)) {
    const compMap = new Map(); // "1" → best string
    const others  = [];
    for (const item of sow) {
      if (typeof item !== 'string') { others.push(item); continue; }
      const m = item.match(/^Component\s+(\d+)\s*[:\-]/i);
      if (m) {
        const num = m[1];
        const prev = compMap.get(num);
        // Keep the most detailed entry (longest string)
        if (!prev || item.length > prev.length) compMap.set(num, item);
      } else {
        // Non-component string — keep only once (exact dedup)
        if (!others.includes(item)) others.push(item);
      }
    }
    // Reassemble sorted by component number
    const sorted = [...compMap.entries()]
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(e => e[1]);
    data.tenderOverview.scopeOfWork = [...sorted, ...others];
  }

  // --- 2. Remove promoted sub-criteria from top-level ----------
  const crit = data && data.evaluationFramework && data.evaluationFramework.technicalEvaluationCriteria;
  if (Array.isArray(crit)) {
    // Collect numbers that are genuine top-level (no "." in number)
    const topNums = new Set(
      crit
        .filter(c => !String(c.criterionNumber || '').includes('.'))
        .map(c => String(c.criterionNumber || ''))
    );
    data.evaluationFramework.technicalEvaluationCriteria = crit.filter(c => {
      const num = String(c.criterionNumber || '');
      if (!num.includes('.')) return true;        // plain integer — top-level
      const parent = num.split('.')[0];
      return !topNums.has(parent);               // remove if parent present
    });
  }

  return data;
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
