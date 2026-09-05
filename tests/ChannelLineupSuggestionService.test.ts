import { describe, expect, test } from 'bun:test'
import {
  parseChannelLineupSuggestion,
  type ChannelLineupSuggestionRequest,
} from '../src/services/ChannelLineupSuggestionService'
import type { StationCollectionOption } from '../src/services/StationAutomationService'

function option(id: number, title: string): StationCollectionOption {
  return {
    id,
    rootId: 'tv',
    identityKey: title.toLowerCase(),
    collectionTitle: title,
    displayTitle: title,
    libraryKind: 'tv',
    genres: ['Family'],
    networks: ['PBS Kids'],
    studios: [],
    firstAirYear: 2020,
    eligibleFiles: 10,
  }
}

const request: ChannelLineupSuggestionRequest = {
  goal: 'A public-media kids channel',
  collections: [option(1, 'One'), option(2, 'Two')],
}

describe('channel lineup suggestion validation', () => {
  test('accepts a unique selection from the supplied catalog', () => {
    expect(
      parseChannelLineupSuggestion(
        JSON.stringify({
          name: 'Public Kids',
          rationale: 'A balanced public-media selection.',
          collectionIds: [2, 1],
        }),
        request
      )
    ).toEqual({
      name: 'Public Kids',
      rationale: 'A balanced public-media selection.',
      collectionIds: [2, 1],
    })
  })

  test('rejects hallucinated and duplicate collection IDs', () => {
    expect(() =>
      parseChannelLineupSuggestion(
        '{"name":"Bad","rationale":"Invented","collectionIds":[99]}',
        request
      )
    ).toThrow('outside the approved catalog')
    expect(() =>
      parseChannelLineupSuggestion(
        '{"name":"Bad","rationale":"Duplicate","collectionIds":[1,1]}',
        request
      )
    ).toThrow('duplicate')
  })
})
