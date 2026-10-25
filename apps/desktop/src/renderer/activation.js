const REASONS = {
  missing: 'هذه النسخة تحتاج إلى تفعيل على هذا الجهاز. أرسل رمز الجهاز التالي إلى البائع ليرسل لك مفتاح التفعيل.',
  format: 'مفتاح التفعيل غير مكتمل أو منسوخ بشكل خاطئ. انسخه كاملًا كما وصلك.',
  signature: 'مفتاح التفعيل غير صحيح.',
  machine: 'مفتاح التفعيل هذا خاص بجهاز آخر. أرسل رمز هذا الجهاز إلى البائع للحصول على مفتاح له.',
  expired: 'انتهت صلاحية الترخيص. تواصل مع البائع لتجديده.',
  clock: 'تاريخ الجهاز أقدم من آخر استخدام للبرنامج. صحّح تاريخ ووقت الجهاز ثم أعد التشغيل.',
};
const $ = (id) => document.getElementById(id);
const show = (text, ok) => {
  $('msg').textContent = text;
  $('msg').className = `msg ${ok ? 'good' : 'bad'}`;
};

window.autohub.activationInfo().then(({ code, reason }) => {
  $('code').textContent = code;
  if (reason !== 'missing') show(REASONS[reason] ?? REASONS.signature, false);
});
$('copy').addEventListener('click', async () => {
  await window.autohub.copy($('code').textContent);
  $('copy').textContent = 'تم النسخ ✓';
});
$('activate').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) return show('الصق مفتاح التفعيل أولًا.', false);
  $('activate').disabled = true;
  const res = await window.autohub.activate(key);
  if (res.ok) {
    show(`تم التفعيل — مرخّص لـ ${res.name}${res.exp ? ` حتى ${res.exp}` : ''}.`, true);
  } else {
    show(REASONS[res.reason] ?? REASONS.signature, false);
    $('activate').disabled = false;
  }
});
$('quit').addEventListener('click', () => window.autohub.quit());
