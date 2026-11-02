import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

import { fitWithin, PHOTO_QUALITY, type PhotoDraft, photoName } from "../lib/attachments.js";
import { newId } from "../platform.js";

export type PhotoOutcome = { photos: PhotoDraft[] } | { error: string };

async function prepare(assets: readonly ImagePicker.ImagePickerAsset[], startIndex: number): Promise<PhotoDraft[]> {
  const photos: PhotoDraft[] = [];
  for (const [index, asset] of assets.entries()) {
    const context = ImageManipulator.manipulate(asset.uri);
    const resize = fitWithin(asset.width, asset.height);
    if (resize) context.resize(resize);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_QUALITY, base64: true });
    if (!saved.base64) continue;
    photos.push({
      id: newId(),
      uri: saved.uri,
      name: photoName(asset.fileName, startIndex + index),
      dataBase64: saved.base64,
    });
  }
  return photos;
}

function failure(cause: unknown, fallback: string): PhotoOutcome {
  return { error: cause instanceof Error && cause.message ? cause.message : fallback };
}

/** Opens the system photo picker. Android's picker needs no permission; iOS asks once. */
export async function pickPhotos(limit: number, startIndex: number): Promise<PhotoOutcome> {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: limit > 1,
      selectionLimit: limit,
      quality: 1,
    });
    if (result.canceled) return { photos: [] };
    return { photos: await prepare(result.assets.slice(0, limit), startIndex) };
  } catch (cause) {
    return failure(cause, "The photos could not be read.");
  }
}

export async function takePhoto(startIndex: number): Promise<PhotoOutcome> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return { error: "ZLI Remote cannot use the camera. Allow it in the phone's settings to take a photo." };
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
    if (result.canceled) return { photos: [] };
    return { photos: await prepare(result.assets.slice(0, 1), startIndex) };
  } catch (cause) {
    return failure(cause, "The photo could not be taken.");
  }
}
