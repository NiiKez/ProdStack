import {
  createElement,
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ForwardedRef,
  type ReactElement,
} from 'react';
import { cn } from '@/lib/cn';

type CardOwnProps = {
  interactive?: boolean;
  className?: string;
};

export type CardProps<E extends ElementType = 'div'> = CardOwnProps & {
  as?: E;
} & Omit<ComponentPropsWithoutRef<E>, keyof CardOwnProps | 'as'>;

const BASE = 'rounded-2xl bg-slate-900 border border-slate-800 shadow-sm text-slate-100';
const INTERACTIVE =
  'transition-all duration-150 hover:-translate-y-0.5 hover:border-slate-700 hover:shadow-md ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ' +
  'motion-reduce:transition-none motion-reduce:hover:translate-y-0';

function CardImpl<E extends ElementType = 'div'>(
  { as, interactive = false, className, ...rest }: CardProps<E>,
  ref: ForwardedRef<Element>
): ReactElement {
  const Component = (as ?? 'div') as ElementType;
  return createElement(Component, {
    ref,
    className: cn(BASE, interactive && INTERACTIVE, className),
    ...rest,
  });
}

export const Card = forwardRef(CardImpl) as <E extends ElementType = 'div'>(
  props: CardProps<E> & { ref?: ForwardedRef<Element> }
) => ReactElement;
