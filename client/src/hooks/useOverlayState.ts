import { useState } from "react";
import type { TopicType } from "../lib/api";

export type ActiveEntity = { type: TopicType; value: string; label?: string };

export function useOverlayState() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [librarySettingsOpen, setLibrarySettingsOpen] = useState(false);
  const [metadataManagerOpen, setMetadataManagerOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [savedFiltersOpen, setSavedFiltersOpen] = useState(false);
  const [favoriteCenterOpen, setFavoriteCenterOpen] = useState(false);
  const [metadataQualityOpen, setMetadataQualityOpen] = useState(false);
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [playlistInitialId, setPlaylistInitialId] = useState<string | null>(null);
  const [entity, setEntity] = useState<ActiveEntity | null>(null);

  return {
    filtersOpen,
    setFiltersOpen,
    librarySettingsOpen,
    setLibrarySettingsOpen,
    metadataManagerOpen,
    setMetadataManagerOpen,
    healthOpen,
    setHealthOpen,
    savedFiltersOpen,
    setSavedFiltersOpen,
    favoriteCenterOpen,
    setFavoriteCenterOpen,
    metadataQualityOpen,
    setMetadataQualityOpen,
    compatibilityOpen,
    setCompatibilityOpen,
    maintenanceOpen,
    setMaintenanceOpen,
    playlistOpen,
    setPlaylistOpen,
    playlistInitialId,
    setPlaylistInitialId,
    entity,
    setEntity
  };
}
