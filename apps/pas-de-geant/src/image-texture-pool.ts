/** Shares image-backed textures and disposes them exactly after the final use. */
export class ImageTexturePool<Image, Texture extends { dispose(): void }> {
  private readonly entries = new Map<
    Image,
    { texture: Texture; references: number }
  >();

  acquire(image: Image, create: () => Texture): Texture {
    const existing = this.entries.get(image);
    if (existing) {
      existing.references += 1;
      return existing.texture;
    }
    const texture = create();
    this.entries.set(image, { texture, references: 1 });
    return texture;
  }

  release(image: Image | undefined): void {
    if (image === undefined) return;
    const entry = this.entries.get(image);
    if (!entry) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    entry.texture.dispose();
    this.entries.delete(image);
  }

  /** Rebind one consumer, retaining its existing reference for the same image. */
  rebind(
    currentImage: Image | undefined,
    nextImage: Image,
    create: () => Texture,
  ): Texture {
    if (currentImage === nextImage) {
      const entry = this.entries.get(nextImage);
      if (!entry) throw new Error("Cannot rebind an image without a texture.");
      return entry.texture;
    }
    this.release(currentImage);
    return this.acquire(nextImage, create);
  }

  dispose(): void {
    for (const { texture } of this.entries.values()) texture.dispose();
    this.entries.clear();
  }
}
