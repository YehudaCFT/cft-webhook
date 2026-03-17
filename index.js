const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Sunwave credentials ──
const SUNWAVE_EMAIL  = process.env.SUNWAVE_EMAIL;
const SUNWAVE_API_ID = process.env.SUNWAVE_API_ID;
const SUNWAVE_SECRET = process.env.SUNWAVE_SECRET;
const SUNWAVE_REALM  = process.env.SUNWAVE_REALM;
const SUNWAVE_URL    = 'https://emr.sunwavehealth.com/SunwaveEMR/api/opportunity/active';

// ── Build Sunwave Authorization header ──
function buildAuthHeader(bodyString) {
  const dateTime    = new Date().toUTCString();
  const dateTimeB64 = Buffer.from(dateTime).toString('base64');
  const md5Hex      = crypto.createHash('md5').update(bodyString).digest('hex');
  const md5B64      = Buffer.from(md5Hex).toString('base64')
                        .replace(/\//g, '_').replace(/\+/g, '-');
  const transactionId = uuidv4();
  const seed = [SUNWAVE_EMAIL, SUNWAVE_API_ID, dateTimeB64, SUNWAVE_REALM, transactionId, md5B64].join(':');
  const hmac = crypto.createHmac('sha512', SUNWAVE_SECRET)
    .update(seed).digest('base64')
    .replace(/\//g, '_').replace(/\+/g, '-');
  return `Digest ${SUNWAVE_EMAIL}:${SUNWAVE_API_ID}:${dateTimeB64}:${SUNWAVE_REALM}:${transactionId}:${md5B64}:${hmac}`;
}

// ── Parse Jotform's nested answers structure ──
// Jotform sends: rawRequest -> answers -> { "11": { answer: { first, last } }, "12": { answer: { month, day, year } } }
function parseJotformAnswers(rawRequest) {
  let parsed;
  try { parsed = JSON.parse(rawRequest); } catch(e) { return {}; }

  const answers = parsed.answers || parsed;
  const f = {};

  for (const qid of Object.keys(answers)) {
    const q = answers[qid];
    const name = q.name;
    const answer = q.answer;
    if (answer === undefined || answer === null) continue;

    if (typeof answer === 'object' && !Array.isArray(answer)) {
      // Compound fields (name, address, date, phone)
      for (const [subkey, val] of Object.entries(answer)) {
        f[`${name}[${subkey}]`] = val;
      }
    } else {
      f[name] = answer;
    }
  }
  return f;
}

// ── Map fields → Sunwave ──
function mapFormToSunwave(f) {
  // Patient name (qid 11)
  const patientFirst = f['name11[first]'] || '';
  const patientLast  = f['name11[last]']  || '';

  // Patient DOB (qid 12) — Sunwave expects YYYY-MM-DD
  const dobMonth = (f['date[month]'] || '').padStart(2, '0');
  const dobDay   = (f['date[day]']   || '').padStart(2, '0');
  const dobYear  =  f['date[year]']  || '';
  const dob      = dobYear ? `${dobYear}-${dobMonth}-${dobDay}` : '';

  // Parent/Guardian name (qid 17)
  const callerFirst = f['name17[first]'] || '';
  const callerLast  = f['name17[last]']  || '';

  // Parent email (qid 20)
  const callerEmail = f['email20'] || '';

  // Parent mobile phone (qid 18)
  const phone = f['phoneNumber18[full]'] || '';

  // Insurance (qid 27: member ID, qid 28: group number)
  const memberId    = f['typeA27'] || '';
  const groupNumber = f['typeA28'] || '';

  // Clinical notes block
  const notes = [
    f['howDid']          ? `Referral source: ${f['howDid']}`                   : '',
    f['legalGuardian']   ? `Guardian relationship: ${f['legalGuardian']}`      : '',
    f['legalGuardian46'] ? `Reason for services: ${f['legalGuardian46']}`      : '',
    f['reasonFor']       ? `History/referral: ${f['reasonFor']}`               : '',
    f['historyRelated']  ? `Expected outcomes: ${f['historyRelated']}`         : '',
    f['school']          ? `School: ${f['school']}`                            : '',
    f['school51']        ? `School district: ${f['school51']}`                 : '',
    f['schoolDistrict']  ? `Grade level: ${f['schoolDistrict']}`               : '',
    f['currentLiving']   ? `Living situation: ${f['currentLiving']}`           : '',
    f['typeA67']         ? `Substance use: ${f['typeA67']}`                    : '',
    f['hasYour']         ? `Eating concerns: ${f['hasYour']}`                  : '',
    f['doesYour']        ? `MH diagnoses: ${f['doesYour']}`                    : '',
    f['doesYour75']      ? `MH medications: ${f['doesYour75']}`                : '',
    f['whoIs']           ? `PCP: ${f['whoIs']}`                                : '',
    f['learningDisabilities'] ? `Abuse history: ${f['learningDisabilities']}`  : '',
    f['hasYour91']       ? `Legal history: ${f['hasYour91']}`                  : '',
    f['doesYour92']      ? `Aggressive behavior: ${f['doesYour92']}`           : '',
    f['typeA13']         ? `Sex assigned at birth: ${f['typeA13']}`            : '',
    f['typeA94']         ? `Comments: ${f['typeA94']}`                         : '',
  ].filter(Boolean).join('\n');

  return {
    account_id:                     `CFT-${Date.now()}`,
    caller_first_name:              callerFirst,
    caller_last_name:               callerLast,
    caller_email:                   callerEmail,
    patient_relationship:           'Parent/Guardian',
    patient_first_name:             patientFirst,
    patient_last_name:              patientLast,
    patient_date_of_birth:          dob,
    patient_phone_mobile:           phone,
    member_id:                      memberId,
    insurance_group_number:         groupNumber,
    message_for_intake:             notes,
    admission_representative_email: SUNWAVE_EMAIL,
  };
}

// ── Webhook endpoint ──
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const rawRequest = body['rawRequest'];
    const fields = rawRequest ? parseJotformAnswers(rawRequest) : body;

    const payload    = mapFormToSunwave(fields);
    const bodyString = JSON.stringify(payload);
    const authHeader = buildAuthHeader(bodyString);

    const response = await fetch(SUNWAVE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: bodyString,
    });

    const result = await response.json();

    if (response.ok) {
      console.log(`[OK] Sunwave record created at ${new Date().toISOString()}`);
      return res.status(200).json({ status: 'success' });
    } else {
      console.error(`[FAIL] Sunwave returned ${response.status}:`, JSON.stringify(result));
      return res.status(500).json({ status: 'error', detail: result });
    }

  } catch (err) {
    console.error('[ERROR]', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// ── Health check ──
app.get('/', (_req, res) => res.send('CFT Webhook — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook listening on port ${PORT}`));
