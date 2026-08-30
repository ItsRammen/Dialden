import { describe, expect, test } from 'bun:test'
import { OpenAiCompatibleReviewAssistant } from '../src/services/review/OpenAiCompatibleReviewAssistant'
import type { DisambiguationRequest } from '../src/services/review/types'

function assistantCapturing(sent: { body?: string }): OpenAiCompatibleReviewAssistant {
  return new OpenAiCompatibleReviewAssistant(
    {
      enabled: true,
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      model: 'test/model',
      requestTimeoutMs: 5000,
      maxConcurrency: 1,
      callBudget: 10,
      decisionPolicy: {
        reviewBand: 'manual',
        missingRating: 'block',
        unrecognizedRating: 'block',
        ambiguousMetadata: 'assist',
        unmatchedMetadata: 'assist',
      },
    },
    async (_url, init) => {
      sent.body = init.body
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    externalId: '12155',
                    confidence: 0.95,
                    reason: 'Runtime matches the feature, not the abridged cut.',
                  }),
                },
              },
            ],
          }),
      }
    }
  )
}

/** The real pair from the library: Burton's film against a 1940s radio cut. */
const alice: DisambiguationRequest = {
  collectionId: 1,
  parsedTitle: 'Alice in Wonderland',
  year: 2010,
  mediaType: 'movie',
  fileRuntimeMinutes: 108,
  candidates: [
    {
      externalId: '12155',
      title: 'Alice in Wonderland',
      year: 2010,
      runtimeMinutes: 108,
      overview: 'Alice, now 19 years old, returns to the whimsical world.',
    },
    {
      externalId: '135361',
      title: 'Alice in Wonderland',
      year: 2010,
      runtimeMinutes: 33,
      overview: 'Originally broadcast on radio back in the 1940s.',
    },
  ],
}

describe('runtime as a disambiguation signal', () => {
  test('sends the measured file runtime', async () => {
    const sent: { body?: string } = {}
    await assistantCapturing(sent).disambiguate(alice)

    expect(sent.body).toContain('Measured file runtime: 108 minutes')
  })

  test('sends each candidate runtime alongside its title', async () => {
    const sent: { body?: string } = {}
    await assistantCapturing(sent).disambiguate(alice)

    expect(sent.body).toContain('runtime=108min')
    expect(sent.body).toContain('runtime=33min')
  })

  test('tells the model what a runtime gap means', async () => {
    const sent: { body?: string } = {}
    await assistantCapturing(sent).disambiguate(alice)

    // Without this the model treats runtime as one more field among many.
    expect(sent.body).toContain('measured from the file itself')
    expect(sent.body).toContain('half or double the length')
  })

  test('omits the line entirely when the file length is unknown', async () => {
    const sent: { body?: string } = {}
    const { fileRuntimeMinutes: _unused, ...withoutRuntime } = alice
    await assistantCapturing(sent).disambiguate(withoutRuntime)

    expect(sent.body).not.toContain('Measured file runtime')
  })

  test('still validates the answer against the candidate set', async () => {
    // Runtime is evidence, not authority: the boundary is unchanged.
    const sent: { body?: string } = {}
    const outcome = await assistantCapturing(sent).disambiguate({
      ...alice,
      candidates: [{ externalId: '999', title: 'Something else', runtimeMinutes: 108 }],
    })

    expect(outcome.status).toBe('rejected')
  })
})
