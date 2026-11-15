/**
 * Deterministic fact gate (verified-base-resume Task 9): every number, vocabulary
 * skill and capitalised name in AI output must already exist in the source facts.
 */
import { describe, expect, it } from 'vitest'
import { findUngroundedTokens } from './fact-gate'

const src = (text: string, skills: string[] = []) => ({ text, skills })

describe('findUngroundedTokens — numbers', () => {
  it('flags a number absent from the source', () => {
    expect(findUngroundedTokens('cut latency by 40%', src('cut latency'))).toEqual(['40'])
  })

  it('grounds a number present in the source text or skills', () => {
    expect(findUngroundedTokens('cut latency by 40%', src('reduced by 40 percent'))).toEqual([])
    expect(findUngroundedTokens('uses version 3.5', src('', ['Python 3.5']))).toEqual([])
  })

  it('compares numbers as tokens, not substrings', () => {
    expect(findUngroundedTokens('cut by 40%', src('cut by 140%'))).toEqual(['40'])
    expect(findUngroundedTokens('cut by 140%', src('cut by 40%'))).toEqual(['140'])
  })

  it('keeps the decimal part of a number', () => {
    expect(findUngroundedTokens('took 3.5 years', src('took 3 years and 5 months'))).toEqual([
      '3.5',
    ])
    expect(findUngroundedTokens('took 3.55 years', src('took 3.5 years'))).toEqual(['3.55'])
  })
})

describe('findUngroundedTokens — capitalised words', () => {
  it('flags a capitalised word absent from the source', () => {
    expect(findUngroundedTokens('Built Kafka pipeline', src('Built a pipeline'))).toEqual(['Kafka'])
  })

  it('grounds it case-insensitively against the text or the skills', () => {
    expect(findUngroundedTokens('Built Kafka pipeline', src('used kafka'))).toEqual([])
    expect(findUngroundedTokens('Built Kafka pipeline', src('', ['Kafka']))).toEqual([])
  })

  it('grounds a capitalised word after Unicode normalisation of both sides', () => {
    // decomposed letters in the output: without NFC a word would stop at the combining mark
    expect(findUngroundedTokens('worked at Zu\u0308rich hub', src('Zürich'))).toEqual([])
    expect(findUngroundedTokens('worked at Mu\u0308ller', src('worked'))).toEqual(['Müller'])
  })

  it('does not flag a sentence-initial word', () => {
    expect(findUngroundedTokens('Led the team', src('the team'))).toEqual([])
    expect(findUngroundedTokens('ok. Led it! Ran it? Shipped', src('ok it'))).toEqual([])
    expect(findUngroundedTokens('ok\nLed it', src('ok it'))).toEqual([])
  })

  it('does not flag a word after a leading bullet', () => {
    expect(findUngroundedTokens('- Led it\n  * Ran it\n• Shipped it', src('it'))).toEqual([])
  })

  it('flags a capitalised word after a mid-line dash', () => {
    expect(findUngroundedTokens('wrote it - Kafka', src('wrote it'))).toEqual(['Kafka'])
  })

  it('never flags a single-letter word', () => {
    expect(findUngroundedTokens('so I wrote it', src('wrote it'))).toEqual([])
  })

  it('does not flag lowercase words', () => {
    expect(findUngroundedTokens('built a pipeline', src(''))).toEqual([])
  })
})

describe('findUngroundedTokens — vocabulary skills', () => {
  it('flags a lowercase vocabulary skill with its surface form', () => {
    expect(findUngroundedTokens('deployed with docker', src('deployed'))).toEqual(['docker'])
  })

  it('reports a multi-token skill as written', () => {
    expect(findUngroundedTokens('built on node js', src('built'))).toEqual(['node js'])
    expect(findUngroundedTokens('wrote c sharp code', src('wrote code'))).toEqual(['c sharp'])
    expect(findUngroundedTokens('ran on .NET daily', src('ran daily'))).toEqual(['.NET'])
    expect(findUngroundedTokens('hosted on amazon web services', src('hosted'))).toEqual([
      'amazon web services',
    ])
  })

  it('does not read a skill inside a longer one as a separate mention', () => {
    expect(findUngroundedTokens('built on node js', src('built on node'))).toEqual([])
    expect(findUngroundedTokens('node js and js', src('and'))).toEqual(['node js', 'js'])
  })

  it('flags only what mentionsSkill counts as a mention', () => {
    // `type script` folds to TypeScript's key, but mentionsSkill does not count it
    expect(findUngroundedTokens('wrote type script', src('wrote'))).toEqual([])
  })

  it('grounds a skill through its synonym group', () => {
    expect(findUngroundedTokens('stored in postgres', src('used PostgreSQL'))).toEqual([])
    expect(findUngroundedTokens('stored in postgres', src('', ['PostgreSQL']))).toEqual([])
  })

  it('grounds a capitalised synonym too', () => {
    expect(findUngroundedTokens('stored in Postgres', src('used PostgreSQL'))).toEqual([])
  })
})

describe('findUngroundedTokens — result shape', () => {
  it('deduplicates case-insensitively in order of first appearance', () => {
    expect(
      findUngroundedTokens('using docker and 40 then Kafka, 40 and KAFKA and Docker', src('using')),
    ).toEqual(['docker', '40', 'Kafka'])
  })

  it('folds case by lowercasing, so ß and SS stay distinct', () => {
    expect(findUngroundedTokens('in Straße and STRASSE', src('in and'))).toEqual([
      'Straße',
      'STRASSE',
    ])
  })

  it('returns nothing when everything is grounded', () => {
    const text = 'Led 12 engineers on Kafka'
    expect(findUngroundedTokens(text, src(text))).toEqual([])
  })
})

describe('findUngroundedTokens — fix round 1', () => {
  it('does not flag a lowercase English word that is also a skill', () => {
    expect(findUngroundedTokens('plan the go-live', src('plan'))).toEqual([])
    expect(findUngroundedTokens('the rest of it', src('it'))).toEqual([])
    expect(findUngroundedTokens('react to change', src('change'))).toEqual([])
    expect(findUngroundedTokens('on each node', src('on'))).toEqual([])
  })

  it('does not flag a sentence-initial English word that is also a skill', () => {
    expect(findUngroundedTokens('Go-live in May.', src('in May'))).toEqual([])
    expect(
      findUngroundedTokens('Done. Rest of the team helped', src('Done the team helped')),
    ).toEqual([])
    expect(findUngroundedTokens('- React to incidents', src('to incidents'))).toEqual([])
  })

  it('still flags the same word mid-sentence, and a sentence-initial non-English skill', () => {
    expect(findUngroundedTokens('we plan Go-live', src('we plan live'))).toEqual(['Go'])
    expect(findUngroundedTokens('Kotlin streams', src('streams'))).toEqual(['Kotlin'])
  })

  it('still flags the capitalised form, and a later unambiguous spelling of the same group', () => {
    expect(findUngroundedTokens('wrote Go and React services', src('wrote and'))).toEqual([
      'Go',
      'React',
    ])
    expect(findUngroundedTokens('the rest of it is restful', src('it'))).toEqual(['restful'])
    expect(findUngroundedTokens('each node runs nodejs', src('runs'))).toEqual(['nodejs'])
  })

  it('flags a sentence-initial word that looks like a name: all caps, inner capital or a digit', () => {
    expect(findUngroundedTokens('AWS hosted it', src('hosted it'))).toEqual(['AWS'])
    expect(findUngroundedTokens('GitHub hosted it', src('hosted it'))).toEqual(['GitHub'])
    expect(findUngroundedTokens('S3 stored it. Ec2 ran it', src('stored ran it 3 2'))).toEqual([
      'S3',
      'Ec2',
    ])
  })

  it('leaves a plain sentence-initial word, or a grounded distinctive one, unflagged', () => {
    expect(findUngroundedTokens('Kafka stored it', src('stored it'))).toEqual([])
    expect(findUngroundedTokens('AWS hosted it', src('aws hosted it'))).toEqual([])
  })

  it('treats numbered items and more bullet glyphs as sentence starts', () => {
    expect(findUngroundedTokens('1) Led it\n 12) Ran it', src('it 1 12'))).toEqual([])
    expect(findUngroundedTokens('– Led it\n— Ran it\n▪ Shipped it', src('it'))).toEqual([])
  })

  it('does not treat a colon or an inline bracket as a sentence start', () => {
    expect(findUngroundedTokens('Stack: Kafka', src(''))).toEqual(['Kafka'])
    expect(findUngroundedTokens('it (and more) Kafka', src('it and more'))).toEqual(['Kafka'])
  })
})
