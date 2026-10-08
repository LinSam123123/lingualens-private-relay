import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from 'react';

/** Listen at the button, before a host site's shadow-DOM event retargeting. */
export function ActionButton({ onActivate, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  onActivate: (event: MouseEvent) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const callback = useRef(onActivate);
  callback.current = onActivate;
  useLayoutEffect(() => {
    const button = ref.current;
    const click = (event: MouseEvent) => callback.current(event);
    button?.addEventListener('click', click);
    return () => button?.removeEventListener('click', click);
  }, []);
  return <button {...props} ref={ref} />;
}
