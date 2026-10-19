import { createElement } from 'react'
import type { LucideProps } from 'lucide-react'
import { iconFor, type IconName } from './icon-map'

export type { IconName }

export interface IconProps extends LucideProps {
  name: IconName | string
}

export function Icon({ name, size = 20, ...props }: IconProps) {
  return createElement(iconFor(name), { size, 'aria-hidden': true, ...props })
}
