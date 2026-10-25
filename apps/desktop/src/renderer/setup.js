const $ = (id) => document.getElementById(id);
const show = (text) => {
  $('msg').textContent = text;
  $('msg').className = 'msg bad';
};

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => $(id).value.trim();
  const password = $('password').value;
  if (v('name').length < 2) return show('اكتب اسم المعرض.');
  if (v('branch').length < 2) return show('اكتب اسم الفرع الرئيسي.');
  if (v('fullName').length < 2) return show('اكتب اسم المالك.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) return show('البريد الإلكتروني غير صحيح.');
  if (password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return show('كلمة المرور يجب أن تكون 10 أحرف على الأقل وفيها حرف إنجليزي ورقم.');
  }
  if (password !== $('password2').value) return show('كلمتا المرور غير متطابقتين.');
  $('submit').disabled = true;
  $('submit').textContent = 'جاري الإنشاء…';
  const res = await window.autohub.setup({
    name: v('name'),
    market: $('market').value,
    branchName: v('branch'),
    owner: { fullName: v('fullName'), email: v('email').toLowerCase(), password },
  });
  if (!res.ok) {
    show(`تعذر إنشاء الشركة: ${res.error}`);
    $('submit').disabled = false;
    $('submit').textContent = 'إنشاء الشركة';
  }
});
