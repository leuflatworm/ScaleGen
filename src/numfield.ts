// スライダーの横に数値入力欄を付ける。
// 数値欄にはスライダーの範囲を超える値も入れられる(data-min / data-max が入力できる範囲)。
// 値の読み出しは数値欄が正で、スライダーは範囲内に丸めた位置を示すだけ。
// 数値欄を変えたらスライダーの 'input' イベントを出すので、スライダーに付けた処理がそのまま動く。
const fields = new Map<string, HTMLInputElement>();

export function attachNumberFields(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('.slider input[type=range]').forEach((range) => {
    const box = range.parentElement!;
    const wrap = document.createElement('span');
    wrap.className = 'numwrap';
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'num';
    num.step = range.step;
    num.min = range.dataset.min ?? range.min;
    num.max = range.dataset.max ?? range.max;
    const decimals = (range.step.split('.')[1] ?? '').length;
    const fmt = (v: number) => v.toFixed(decimals);
    num.value = fmt(Number(range.value));
    wrap.appendChild(num);
    if (range.dataset.unit) {
      const u = document.createElement('span');
      u.className = 'unit';
      u.textContent = range.dataset.unit;
      wrap.appendChild(u);
    }
    box.querySelector('output')?.remove();
    box.appendChild(wrap);
    if (range.id) fields.set(range.id, num);

    let fromNumber = false;
    range.addEventListener('input', () => {
      if (!fromNumber) num.value = fmt(Number(range.value));
    });
    const clampHard = (v: number) => Math.min(Number(num.max), Math.max(Number(num.min), v));
    const apply = (commit: boolean) => {
      const raw = Number(num.value);
      if (num.value === '' || !Number.isFinite(raw)) {
        if (commit) num.value = fmt(Number(range.value));
        return;
      }
      const v = clampHard(raw);
      if (commit) num.value = fmt(v);
      range.value = String(v);           // 範囲外ならスライダーは端に止まる
      fromNumber = true;
      range.dispatchEvent(new Event('input'));
      fromNumber = false;
    };
    num.addEventListener('input', () => apply(false));
    num.addEventListener('change', () => apply(true));
  });
}

// 値を読む(数値欄があればそちら。スライダー範囲外の値もそのまま返す)
export function sliderValue(id: string): number {
  const f = fields.get(id);
  if (f) {
    const v = Number(f.value);
    if (f.value !== '' && Number.isFinite(v)) return Math.min(Number(f.max), Math.max(Number(f.min), v));
  }
  return Number((document.getElementById(id) as HTMLInputElement).value);
}
