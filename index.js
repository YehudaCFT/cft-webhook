const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Accept all possible formats Jotform might send
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, _res, next) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { req.rawData = data; } catch(e) {}
      next();
    });
  } else {
    next();
  }
});

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

  // Client name — Jotform unique name: name11
  const patientFirst = fields['name11[first]'] || fields['first_11'] || '';
  const patientLast  = fields['name11[last]']  || fields['last_11']  || '';

  // Parent/Guardian name — Jotform unique name: name17
  const callerFirst  = fields['name17[first]'] || fields['first_17'] || '';
  const callerLast   = fields['name17[last]']  || fields['last_17']  || '';

  // DOB — Jotform unique name: date (month_12, day_12, year_12)
  const dobMonth = fields['date[month]'] || fields['month_12'] || '';
  const dobDay   = fields['date[day]']   || fields['day_12']   || '';
  const dobYear  = fields['date[year]']  || fields['year_12']  || '';
  const dob      = (dobMonth && dobDay && dobYear) ? `${dobYear}-${dobMonth.padStart(2,'0')}-${dobDay.padStart(2,'0')}` : '';

  // Phone — Jotform unique name: phoneNumber18
  const phone = fields['phoneNumber18[full]'] || fields['phoneNumber18'] || '';

  // Build a plain-text clinical notes block from pre-screener / clinical fields
  const notes = [
    fields['howDidYouHear']       ? `Referral source: ${fields['howDidYouHear']}`            : '',
    fields['reasonForServices']   ? `Reason for services: ${fields['reasonForServices']}`    : '',
    fields['historyReason']       ? `History/referral: ${fields['historyReason']}`           : '',
    fields['expectedOutcomes']    ? `Expected outcomes: ${fields['expectedOutcomes']}`       : '',
    fields['school']              ? `School: ${fields['school']}`                            : '',
    fields['schoolDistrict']      ? `School district: ${fields['schoolDistrict']}`           : '',
    fields['gradeLevel']          ? `Grade: ${fields['gradeLevel']}`                         : '',
    fields['livingSituation']     ? `Living situation: ${fields['livingSituation']}`         : '',
    fields['substanceUse']        ? `Substance use: ${fields['substanceUse']}`               : '',
    fields['eatingConcerns']      ? `Eating concerns: ${fields['eatingConcerns']}`           : '',
    fields['psychiatricSymptoms'] ? `Psychiatric symptoms: ${fields['psychiatricSymptoms']}` : '',
    fields['priorMHDiagnoses']    ? `Prior MH diagnoses: ${fields['priorMHDiagnoses']}`     : '',
    fields['medications']         ? `Medications: ${fields['medications']}`                  : '',
    fields['primaryCareProvider'] ? `PCP: ${fields['primaryCareProvider']}`                 : '',
    fields['abuseHistory']        ? `Abuse history: ${fields['abuseHistory']}`              : '',
    fields['legalHistory']        ? `Legal history: ${fields['legalHistory']}`              : '',
    fields['comments']            ? `Comments: ${fields['comments']}`                       : '',
  ].filter(Boolean).join('\n');

  return {
    account_id:                    `CFT-${Date.now()}`,
    caller_first_name:             callerFirst,
    caller_last_name:              callerLast,
    caller_email:                  fields['email17'] || fields['email'] || '',
    patient_relationship:          fields['relationship'] || 'Parent/Guardian',
    patient_first_name:            patientFirst,
    patient_last_name:             patientLast,
    patient_date_of_birth:         dob,
    patient_phone_mobile:          phone,
    insurance_group_number:        fields['groupNumber'] || '',
    member_id:                     fields['memberID']    || '',
    message_for_intake:            notes,
    admission_representative_email: SUNWAVE_EMAIL,
  };
}

// ── Webhook endpoint ──
app.post('/webhook', async (req, res) => {

  try {
    // Parse body from all possible Jotform formats
    let fields = {};
    if (req.body && Object.keys(req.body).length > 0) {
      fields = req.body['rawRequest'] ? JSON.parse(req.body['rawRequest']) : req.body;
    } else if (req.rawData) {
      try {
        // Try JSON first
        fields = JSON.parse(req.rawData);
      } catch(e) {
        // Try URL-encoded
        const params = new URLSearchParams(req.rawData);
        params.forEach((v, k) => { fields[k] = v; });
        if (fields['rawRequest']) fields = JSON.parse(fields['rawRequest']);
      }
    }

    // TEMPORARY DEBUG — logs raw body to see exactly what Jotform sends
    console.log('[DEBUG] Raw body keys:', Object.keys(req.body || {}).join(', '));
    console.log('[DEBUG] Fields found:', Object.keys(fields).join(', '));
    console.log('[DEBUG] Raw data sample:', (req.rawData || '').substring(0, 500));

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
