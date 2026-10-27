/** Use explicit genre metadata; an incomplete one-person cast is not proof of a solo work. */
export function entitySoloFilter(type:string,soloOnly:boolean):string {
  return type==='actor'&&soloOnly ? ` AND media_files.media_type = 'video' AND EXISTS (
    SELECT 1 FROM media_metadata_facets solo_genre
    WHERE solo_genre.normalized_code = media_files.normalized_code
      AND solo_genre.facet_type = 'genre'
      AND solo_genre.facet_value IN ('単体作品', '单体作品', '單體作品')
  )` : '';
}
