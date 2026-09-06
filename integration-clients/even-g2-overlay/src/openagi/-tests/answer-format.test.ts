import { expect, it } from 'vitest'
import { plainAnswer } from '../answer-format'
import { paginateText } from '../../state/ask-state-machine'

it('removes Markdown while retaining readable text and every page tail', () => {
  expect(plainAnswer('# Result\n**Hello** [world](https://example.com)\n- `one`')).toBe('Result\nHello world\n• one')
  const text = Array.from({ length: 220 }, (_, i) => `word${i}`).join(' ')
  const pages = paginateText(plainAnswer(text), 260)
  expect(pages.every(page => page.length <= 260)).toBe(true)
  expect(pages.join(' ')).toBe(text)
})
