import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MoneyInput, PercentInput } from './Field';

afterEach(cleanup);

describe('MoneyInput', () => {
  it('lays the tag and the digits out left-to-right whatever the page direction', () => {
    const { container } = render(
      <div dir="rtl">
        <MoneyInput currency="USD" defaultValue="1234567.89" />
      </div>,
    );
    const box = container.querySelector('div[dir="rtl"] > div')!;
    const input = box.querySelector('input')!;
    const tag = box.querySelector('span')!;
    expect(box.getAttribute('dir')).toBe('ltr');
    expect(input.getAttribute('dir')).toBe('ltr');
    expect(input.className).toContain('num');
    expect(tag.textContent).toBe('USD');
    // The tag sits at the start (left) of the LTR box and the padding is reserved on that same side.
    expect(tag.className).toContain('start-3');
    expect(input.style.paddingInlineStart).toMatch(/^calc\(/);
    expect(input.style.paddingInlineEnd).toBe('');
  });

  it('keeps the old API: no tag without a currency, forwarded ref, overridable placeholder', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<MoneyInput ref={ref} placeholder="1.00" invalid className="w-40" />);
    const input = container.querySelector('input')!;
    expect(ref.current).toBe(input);
    expect(container.querySelector('span')).toBeNull();
    expect(input.style.paddingInlineStart).toBe('');
    expect(input.placeholder).toBe('1.00');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.inputMode).toBe('decimal');
    expect(input.className).toContain('w-40');
  });
});

describe('PercentInput', () => {
  it('puts the % suffix at the end (right) and reserves the padding there', () => {
    const { container } = render(<PercentInput defaultValue="2.5" />);
    const input = container.querySelector('input')!;
    const tag = container.querySelector('span')!;
    expect(tag.textContent).toBe('%');
    expect(tag.className).toContain('end-3');
    expect(input.style.paddingInlineEnd).toMatch(/^calc\(/);
    expect(input.placeholder).toBe('0');
  });
});
