export function catalogCollectionVisible(collectionId, collections, preferences = {}) {
  if (preferences.mode === 'single') return collectionId === preferences.collection_id
    && collections.some((c) => c.id === collectionId && c.is_active !== false);
  if (!collectionId) return preferences.mode === 'all';
  return collections.some((c) => c.id === collectionId && c.is_active !== false);
}
