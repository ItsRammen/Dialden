import { afterEach, describe, expect, test } from 'bun:test'
import { createCollectionLibraryPageController } from '../src/controllers/CollectionLibraryPageController'
import { MediaRepository } from '../src/repositories/MediaRepository'
import { CollectionLibraryService } from '../src/services/CollectionLibraryService'
import type { CollectionUpsertInput, LibraryKind } from '../src/types'

function collectionInput(
  kind: Extract<LibraryKind, 'tv' | 'movie'>,
  index: number,
  prefix: string
): CollectionUpsertInput {
  const title = `${prefix} ${String(index).padStart(3, '0')}`
  return {
    rootId: kind,
    libraryKind: kind,
    identityKey: `${kind}:${index}`,
    sourceTitle: title,
    parsedTitle: title,
    year: 2020,
  }
}

function pageController(repository: MediaRepository) {
  return createCollectionLibraryPageController({
    library: new CollectionLibraryService(repository),
    metadata: {
      async confirmMatch() {
        return null
      },
      async retryCollection() {
        return null
      },
    },
  })
}

describe('collection library pagination', () => {
  const repositories: MediaRepository[] = []

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  })

  test('TV and movie pages expose collections after the old 250-row ceiling', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    await repository.upsertCollections([
      ...Array.from({ length: 255 }, (_, index) =>
        collectionInput('tv', index, 'TV Title')
      ),
      ...Array.from({ length: 255 }, (_, index) =>
        collectionInput('movie', index, 'Movie Title')
      ),
    ])
    const app = pageController(repository)

    const tvResponse = await app.request('/library/tv?page=6')
    const movieResponse = await app.request('/library/movies?page=6')
    const tvMarkup = await tvResponse.text()
    const movieMarkup = await movieResponse.text()

    expect(tvResponse.status).toBe(200)
    expect(movieResponse.status).toBe(200)
    expect(tvMarkup).toContain('TV Title 254')
    expect(movieMarkup).toContain('Movie Title 254')
    expect(tvMarkup).toContain('Page 6')
    expect(movieMarkup).toContain('Page 6')
  })

  test('late approval and metadata review rows are filtered before pagination', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    const collections = await repository.upsertCollections(
      Array.from({ length: 261 }, (_, index) =>
        collectionInput('tv', index, 'Review Candidate')
      )
    )
    for (const collection of collections.slice(0, -1)) {
      await repository.updateCollectionPolicy(
        collection.id,
        'allow',
        'test_allowed'
      )
    }
    const lateCollection = collections.at(-1)
    if (!lateCollection) throw new Error('Expected a late collection')
    await repository.updateCollectionMetadata(lateCollection.id, {
      provider: 'tmdb',
      externalId: null,
      status: 'unmatched',
      ratingStatus: 'missing',
      error: 'No reliable match',
    })
    const app = pageController(repository)

    const approvalResponse = await app.request('/library/review')
    const metadataResponse = await app.request('/library/review/metadata')
    const approvalMarkup = await approvalResponse.text()
    const metadataMarkup = await metadataResponse.text()

    expect(approvalResponse.status).toBe(200)
    expect(metadataResponse.status).toBe(200)
    expect(approvalMarkup).toContain('Review Candidate 260')
    expect(metadataMarkup).toContain('Review Candidate 260')
    expect(approvalMarkup).toContain('Approval 1')
    expect(metadataMarkup).toContain('Metadata 1')
  })

  test('previous and next links preserve approval and search filters', async () => {
    const repository = new MediaRepository(':memory:')
    repositories.push(repository)
    await repository.initialize()
    await repository.upsertCollections(
      Array.from({ length: 255 }, (_, index) =>
        collectionInput('tv', index, 'Filtered Title')
      )
    )
    const app = pageController(repository)

    const response = await app.request(
      '/library/tv?status=review&search=Filtered%20Title&page=5'
    )
    const markup = await response.text()

    expect(markup).toContain(
      'href="/library/tv?status=review&amp;search=Filtered+Title&amp;page=4"'
    )
    expect(markup).toContain(
      'href="/library/tv?status=review&amp;search=Filtered+Title&amp;page=6"'
    )
    expect(markup).toContain('Page 5')
  })
})
