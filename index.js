const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Sunwave credentials (loaded from environment variables ONLY) ──
const SUNWAVE_EMAIL  = process.env.SUNWAVE_EMAIL;
const SUNWAVE_API_ID = process.env.SUNWAVE_API_ID;
const SUNWAVE_SECRET = process.env.SUNWAVE_SECRET;
const SUNWAVE_REALM  = process.env.SUNWAVE_REALM;
const SUNWAVE_URL    = 'https://emr.sunwavehealth.com/SunwaveEMR/api/opportunity/active';

// ── Build Sunwave Authorization header ──
function buildAuthHeader(bodyString) {
  const dateTime      = new Date().toUTCString();                          // e.g. "Mon, 15 Jan 2026 13:45:12 GMT"
  const dateTimeB64   = Buffer.from(dateTime).toString('base64');

  const md5Hex        = crypto.createHash('md5').update(bodyString).digest('hex');
  const md5B64        = Buffer.from(md5Hex)
                          .toString('base64')
                          .replace(/\//g, '_')
                          .replace(/\+/g, '-');

  const transactionId = uuidv4();

  const seed = [
    SUNWAVE_EMAIL,
    SUNWAVE_API_ID,
    dateTimeB64,
    SUNWAVE_REALM,
    transactionId,
    md5B64
  ].join(':');

  const hmac = crypto
    .createHmac('sha512', SUNWAVE_SECRET)
    .update(seed)
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-');

  return `Digest ${SUNWAVE_EMAIL}:${SUNWAVE_API_ID}:${dateTimeB64}:${SUNWAVE_REALM}:${transactionId}:${md5B64}:${hmac}`;
}

// ── Map Jotform fields → Sunwave fields ──
function mapFormToSunwave(fields) {

  // Helper: split "First Last" into parts
  const splitName = (full = '') => {
    const parts = full.trim().split(/\s+/);
    return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
  };

  const clientName  = splitName(fields['clientName']  || fields['name']);
  const parentName  = splitName(fields['parentName']  || fields['guardianName']);

  // Build a plain-text clinical notes block from pre-screener / clinical fields
  const notes = [
    fields['howDidYouHear']       ? `Referral source: ${fields['howDidYouHear']}`          : '',
    fields['reasonForServices']   ? `Reason for services: ${fields['reasonForServices']}`  : '',
    fields['historyReason']       ? `History/referral: ${fields['historyReason']}`         : '',
    fields['expectedOutcomes']    ? `Expected outcomes: ${fields['expectedOutcomes']}`     : '',
    fields['school']              ? `School: ${fields['school']}`                          : '',
    fields['schoolDistrict']      ? `School district: ${fields['schoolDistrict']}`         : '',
    fields['gradeLevel']          ? `Grade: ${fields['gradeLevel']}`                       : '',
    fields['livingSituation']     ? `Living situation: ${fields['livingSituation']}`       : '',
    fields['substanceUse']        ? `Substance use: ${fields['substanceUse']}`             : '',
    fields['eatingConcerns']      ? `Eating concerns: ${fields['eatingConcerns']}`         : '',
    fields['psychiatricSymptoms'] ? `Psychiatric symptoms: ${fields['psychiatricSymptoms']}` : '',
    fields['priorMHDiagnoses']    ? `Prior MH diagnoses: ${fields['priorMHDiagnoses']}`   : '',
    fields['medications']         ? `Medications: ${fields['medications']}`                : '',
    fields['primaryCareProvider'] ? `PCP: ${fields['primaryCareProvider']}`               : '',
    fields['abuseHistory']        ? `Abuse history: ${fields['abuseHistory']}`            : '',
    fields['legalHistory']        ? `Legal history: ${fields['legalHistory']}`            : '',
    fields['comments']            ? `Comments: ${fields['comments']}`                     : '',
  ].filter(Boolean).join('\n');

  return {
    caller_first_name:          parentName.first,
    caller_last_name:           parentName.last,
    caller_email:               fields['parentEmail']   || fields['email'] || '',
    patient_relationship:       fields['relationship']  || 'Parent/Guardian',
    patient_first_name:         clientName.first,
    patient_last_name:          clientName.last,
    patient_date_of_birth:      fields['clientDOB']     || fields['dob']   || '',
    patient_phone_mobile:       fields['parentPhone']   || fields['phone'] || '',
    insurance_group_number:     fields['groupNumber']   || '',
    member_id:                  fields['memberID']      || '',
    message_for_intake:         notes,
    admission_representative_email: SUNWAVE_EMAIL,
  };
}

// ── Webhook endpoint ──
app.post('/webhook', async (req, res) => {

  try {
    const raw    = req.body;
    const fields = raw['rawRequest'] ? JSON.parse(raw['rawRequest']) : raw;

    const payload     = mapFormToSunwave(fields);
    const bodyString  = JSON.stringify(payload);
    const authHeader  = buildAuthHeader(bodyString);

    const response = await fetch(SUNWAVE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': authHeader,
      },
      body: bodyString,
    });

    const result = await response.json();

    if (response.ok) {
      // HIPAA-safe log: no PHI, just success signal
      console.log(`[OK] Sunwave record created at ${new Date().toISOString()}`);
      return res.status(200).json({ status: 'success' });
    } else {
      console.error(`[FAIL] Sunwave returned ${response.status}:`, JSON.stringify(result));
      return res.status(500).json({ status: 'error', detail: result });
    }

  } catch (err) {
    console.error('[ERROR] Webhook handler threw:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// ── Health check (Render uses this to confirm the app is alive) ──
app.get('/', (_req, res) => res.send('CFT Webhook — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook listening on port ${PORT}`));
