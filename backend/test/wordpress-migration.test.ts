import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExport, extractImages, downloadImage } from "../scripts/temp-wordpress.js";
import { sanitizeContent } from "../src/news/validation.js";

const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<wp:wxr_version>1.2</wp:wxr_version><wp:base_blog_url>https://example.com</wp:base_blog_url>
<wp:author><wp:author_id>8</wp:author_id><wp:author_login>writer</wp:author_login><wp:author_display_name>Writer</wp:author_display_name></wp:author>
<item><title>Old article</title><link>https://example.com/2023/old/</link><dc:creator>writer</dc:creator><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type><wp:post_name>old</wp:post_name><wp:status>publish</wp:status><wp:post_date_gmt>2023-07-31 11:01:31</wp:post_date_gmt><wp:post_modified_gmt>2023-08-01 11:01:31</wp:post_modified_gmt><content:encoded><![CDATA[<p>Full text<img class="wp-image-2" src="https://example.com/image-300x200.jpg" alt="Alt"></p><script>bad()</script>]]></content:encoded><category domain="category" nicename="brasil">Brasil</category><category domain="post_tag" nicename="tag">Tag</category><wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>2</wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key>_aioseo_title</wp:meta_key><wp:meta_value>SEO title</wp:meta_value></wp:postmeta><wp:postmeta><wp:meta_key>plugin_secret</wp:meta_key><wp:meta_value>do not import</wp:meta_value></wp:postmeta></item>
<item><title>Image</title><wp:post_id>2</wp:post_id><wp:post_type>attachment</wp:post_type><wp:attachment_url>https://example.com/image.jpg</wp:attachment_url></item>
</channel></rss>`;
test("migration reads original dates, authors, taxonomy and public SEO without importing plugin settings", () => {
  const p = parseExport(xml), post = p.posts[0];
  assert.equal(post.createdAt?.toISOString(), "2023-07-31T11:01:31.000Z");
  assert.equal(post.updatedAt?.toISOString(), "2023-08-01T11:01:31.000Z");
  assert.equal(post.url, "https://example.com/2023/old/"); assert.equal(post.author, "writer");
  assert.equal(post.categories[0].name, "Brasil"); assert.equal(post.tags[0].name, "Tag");
  assert.equal(post.meta._aioseo_title, "SEO title"); assert.equal(post.meta.plugin_secret, undefined);
});
test("cover and resized inline image resolve to one original attachment, and executable markup is stripped", () => {
  const p = parseExport(xml), e = extractImages(p.posts[0], p.attachments, p.site);
  try {
    assert.equal(e.images.length, 1); assert.equal(e.images[0].cover, true); assert.equal(e.images[0].url, "https://example.com/image.jpg");
    const img = e.dom.window.document.querySelector("img")!; img.setAttribute("src", "/media/news/11111111-1111-4111-8111-111111111111.webp");
    const safe = sanitizeContent(e.dom.window.document.body.innerHTML);
    assert.match(safe, /Full text/); assert.equal(safe.includes("script"), false); assert.equal(safe.includes("bad()"), false);
  } finally { e.dom.window.close(); }
});
test("XML external entities and image downloads outside the original WordPress host are rejected", async () => {
  assert.throws(() => parseExport('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]>'+xml));
  await assert.rejects(downloadImage("https://attacker.test/image.jpg", new URL("https://example.com")), /Origem/);
  await assert.rejects(downloadImage("file:///image.jpg", new URL("https://example.com")), /Origem/);
});
