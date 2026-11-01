# Live data changes

Changes made directly in the **live database** (Atlas, `restaurant_billing` – the one
jaiva-book.vercel.app uses), outside the app's own screens. Newest first. Code changes are in git;
this file is only for data.

---

## 2026-11-01 – Photos for the Idly Tiffin House main menu

- **Who / why:** done by Claude Code at the owner's request ("menu la items ku img add panu db la"),
  with free stock photos.
- **What changed:** the 18 main-menu dishes of *Idly Tiffin House* had no photo. Each got one:
  - `menuitems.imageUrl` set from `null` to `/uploads/menu/<id>.jpg` (only where it was still `null`;
    no existing photo was replaced; branch photos and variants untouched).
  - 18 new documents in `menuimages` (the photo bytes, 60–230 KB each).
  - 18 `auditlogs` entries: action `MENU_ITEM_IMAGE_UPDATED`, actor `system`, with the source page,
    licence and author in `meta`. They show in Super Admin › Audit Log.
- **Photos:** Wikimedia Commons, free licences; authors and licences in
  [MENU_PHOTO_CREDITS.md](MENU_PHOTO_CREDITS.md) (CC BY / CC BY-SA ask for this credit).
- **Checked:** afterwards no active dish was without a photo, and two of the files loaded from
  jaiva-book.vercel.app (200, image/jpeg).

| Dish | imageUrl |
|---|---|
| Idly | /uploads/menu/2e9596cc-4c46-4f6f-9bc1-fb772c4b5528.jpg |
| Pongal | /uploads/menu/ea3c9547-509d-43f9-8bde-ca72ea214e96.jpg |
| Dosa | /uploads/menu/7ddacc0c-3612-4a2f-b995-aec6e8d8851a.jpg |
| Vada | /uploads/menu/489613c5-967a-40dc-9d3e-15cbea2b9467.jpg |
| Chapati | /uploads/menu/c7eb23cf-bd5c-438b-9bdf-f5b93069c3b3.jpg |
| Poori | /uploads/menu/64c7ee1d-156a-4096-aff0-8614593f5c03.jpg |
| Parotta | /uploads/menu/ac38a9d1-b61a-4075-b798-a513ed2e2526.jpg |
| Fried Rice | /uploads/menu/45e0e190-a550-444d-a7e6-746cfc1a017c.jpg |
| Lemon Rice | /uploads/menu/41834f78-fb18-4e54-9512-53c4a565193a.jpg |
| Noodles | /uploads/menu/493271ce-f6e5-4a70-a896-36a0f06a4069.jpg |
| Tomato Rice | /uploads/menu/c0743094-6ec7-49c7-b318-ca1723db4782.jpg |
| Filter Coffee | /uploads/menu/40e8db7b-250a-460d-99cb-fef704d14321.jpg |
| Masala Tea | /uploads/menu/8f131143-a34e-4809-a024-eda035ff4d8c.jpg |
| Veg Biryani | /uploads/menu/5facaeb1-1325-4a84-838e-edd557028246.jpg |
| Fresh Juice | /uploads/menu/30e0430a-1ed3-4db5-863b-f67b572790ff.jpg |
| Gulab Jamun | /uploads/menu/8749781b-09c1-44f3-997b-6a03f2f97d17.jpg |
| Masala Dosa | /uploads/menu/3654e07a-eaf5-4ade-baef-167886a0a161.jpg |
| Curd Rice | /uploads/menu/1f725d24-a2e8-404b-897d-bd2041e7f47b.jpg |

- **To undo one photo:** Menu › Edit the dish › remove photo (or upload your own).
- **To undo all:** in the database, for the URLs above set `menuitems.imageUrl` back to `null`.
  Keep the `menuimages` files – bills generated since then may show these photos.
