#!/bin/bash

SRC_DIR="packSource"
DST_DIR="packTarget"

mkdir -p "$DST_DIR"

shopt -s nullglob
for file in "$SRC_DIR"/*.jpg; do
  base_name=$(basename "$file" .jpg)
  tmp_file="$DST_DIR/${base_name}_tmp.jpg"
  
  convert "$file" \
    -auto-orient \
    -resize "1536x1536>" \
    -strip \
    -quality 85 \
    "$tmp_file"
  
  new_res=$(identify -format "%wx%h" "$tmp_file")
  final_file="$DST_DIR/${base_name}_${new_res}.jpg"
  mv "$tmp_file" "$final_file"
  
  echo "Done: $(basename "$final_file")"
done
