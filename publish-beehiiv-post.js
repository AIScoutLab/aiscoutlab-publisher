require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const slugify = require("slugify");
const { v2: cloudinary } = require("cloudinary");

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const BEEHIIV_PUBLICATION_ID = process.env.BEEHIIV_PUBLICATION_ID;

if (!BEEHIIV_API_KEY || !BEEHIIV_PUBLICATION_ID) {
  throw new Error("Missing BEEHIIV_API_KEY or BEEHIIV_PUBLICATION_ID in .env");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function getTodayString() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function makeSafeSlug(text) {
  return slugify(text, { lower: true, strict: true, trim: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resizeImageForBeehiiv(inputPath, outputPath) {
  await sharp(inputPath)
    .resize(1600, 900, {
      fit: "cover",
      position: "center",
    })
    .png({ quality: 95, compressionLevel: 9 })
    .toFile(outputPath);
}

async function uploadToCloudinary(filePath, titleSlug, dateStr) {
  const result = await cloudinary.uploader.upload(filePath, {
    folder: "aiscoutlab/beehiiv",
    public_id: `${dateStr}-${titleSlug}`,
    overwrite: true,
    resource_type: "image",
  });

  return result.secure_url;
}

async function beehiivRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${BEEHIIV_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `Beehiiv API error ${res.status}: ${
        typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }`
    );
  }

  return data;
}

async function createBeehiivPost({
  title,
  subtitle,
  html,
  thumbnailImageUrl,
  slug,
}) {
  const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUBLICATION_ID}/posts`;

  const payload = {
    title,
    subtitle,
    body_content: html,
    status: "confirmed", // publishes immediately
    thumbnail_image_url: thumbnailImageUrl,
    content_tags: ["AIScoutLab"],
    social_share: "top",
    web_settings: {
      slug,
      seo_title: title,
      seo_description: subtitle || "",
    },
  };

  return beehiivRequest(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function getBeehiivPostBySlug(slug) {
  const url = new URL(
    `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUBLICATION_ID}/posts`
  );

  url.searchParams.append("slugs[]", slug);
  url.searchParams.append("limit", "1");

  const data = await beehiivRequest(url.toString(), {
    method: "GET",
  });

  if (!data?.data?.length) {
    return null;
  }

  return data.data[0];
}

async function waitForPublishedPost(slug, maxAttempts = 10, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const post = await getBeehiivPostBySlug(slug);

    if (post && post.web_url) {
      return post;
    }

    console.log(`Waiting for Beehiiv URL... attempt ${attempt}/${maxAttempts}`);
    await sleep(delayMs);
  }

  throw new Error("Could not retrieve Beehiiv post URL.");
}

function buildNewsletterHtml({ title, subtitle, imageUrl, summary }) {
  return `
    <p>
      <img src="${imageUrl}" style="width:100%;border-radius:12px;" />
    </p>
    <h2>${title}</h2>
    <p>${subtitle}</p>
    <p><strong>TL;DR:</strong> ${summary}</p>
    <p>Write your full AIScoutLab breakdown here.</p>
  `;
}

function buildSocialPost({ teaserText, postUrl }) {
  return `${teaserText}

Full breakdown:
${postUrl}`;
}

async function main() {
  try {
    const inputImage = process.argv[2];
    const title = process.argv[3];
    const subtitle = process.argv[4] || "Daily AI signals for operators";
    const summary = process.argv[5] || "Add summary here.";
    const teaserText =
      process.argv[6] ||
      `AI companies are still competing on models.

But workflow is where retention gets built.
And retention is where pricing power comes from.`;

    if (!inputImage || !title) {
      console.error("Usage: node publish-beehiiv-post.js <image> <title>");
      process.exit(1);
    }

    const dateStr = getTodayString();
    const titleSlug = makeSafeSlug(title);
    const slug = `${dateStr}-${titleSlug}`;

    const outputDir = path.join(process.cwd(), "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    const resizedPath = path.join(outputDir, `${slug}.png`);

    console.log("Resizing image...");
    await resizeImageForBeehiiv(inputImage, resizedPath);

    console.log("Uploading image...");
    const imageUrl = await uploadToCloudinary(resizedPath, titleSlug, dateStr);

    const html = buildNewsletterHtml({
      title,
      subtitle,
      imageUrl,
      summary,
    });

    console.log("Publishing to Beehiiv...");
    await createBeehiivPost({
      title,
      subtitle,
      html,
      thumbnailImageUrl: imageUrl,
      slug,
    });

    console.log("Fetching post URL...");
    const post = await waitForPublishedPost(slug);

    const socialPost = buildSocialPost({
      teaserText,
      postUrl: post.web_url,
    });

    console.log("\n=== POST URL ===");
    console.log(post.web_url);

    console.log("\n=== SOCIAL POST ===");
    console.log(socialPost);

  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
}

main();
