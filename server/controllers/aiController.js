// import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import FormData from "form-data";

// --- FIXED: Native ESM imports for modern pdf-parse ---
import { CanvasFactory } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Helper function to pause execution for a set amount of milliseconds
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const generateArticle = async (req, res) => {
  console.log("generateArticle HIT");

  try {
    const { userId } = req.auth();
    const { prompt, length } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan !== "premium" && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Limit reached. Upgrade to continue.",
      });
    }

    let response;
    const maxRetries = 3;

    // Retry loop to handle 503 (Overloaded) or 429 (Rate Limited) errors
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await ai.models.generateContent({
          model: "gemini-3.5-flash", // UPDATED: Changed to a stable, valid model
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Write a detailed article (${length} words) on:\n\n${prompt}`,
                },
              ],
            },
          ],
        });

        // If successful, break out of the retry loop
        break;
      } catch (apiError) {
        // If it's a 503 or 429, and we have retries left, wait and try again
        if (
          (apiError.status === 503 || apiError.status === 429) &&
          attempt < maxRetries
        ) {
          console.log(
            `API overloaded. Attempt ${attempt} failed. Retrying in ${attempt * 2} seconds...`,
          );
          await delay(attempt * 2000); // Waits 2s, then 4s, then gives up
        } else {
          // If it's a different error (like 400 Bad Request) or we are out of retries, throw it
          throw apiError;
        }
      }
    }

    const content = response.text;

    if (!content) {
      return res.json({
        success: false,
        message: "Gemini returned empty content",
      });
    }

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${prompt}, ${content}, 'article')
    `;

    if (plan !== "premium") {
      await clerkClient.users.updateUserMetadata(userId, {
        privateMetadata: {
          free_usage: free_usage + 1,
        },
      });
    }

    res.json({ success: true, content });
  } catch (error) {
    console.error("Gemini error:", error);
    res.json({
      success: false,
      message:
        "Error generating article: API is currently overloaded. Please try again in a few moments.",
    });
  }
};

export const generateBlogTitle = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan !== "premium" && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Limit reached. Please upgrade to premium plan",
      });
    }

    // UPDATED: Using the 'ai' instance instead of 'openai'
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", // Note: Updated to a stable model name
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Generate 10 catchy blog titles for the topic "${prompt}".Return only the titles, one per line, without numbering.`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.7,
        maxOutputTokens: 100, // Replaces OpenAI's max_tokens
      },
    });

    console.log("FULL RESPONSE:", response);
    console.log("TEXT:", response.text);
    // UPDATED: Parsing the response using Gemini's structure
    const content = response.text;

    if (!content) {
      return res.json({
        success: false,
        message: "Gemini returned empty content",
      });
    }

    await sql`INSERT INTO creations (user_id , prompt , content , type) VALUES (${userId} , ${prompt} , ${content} , 'blog-title')`;

    if (plan !== "premium") {
      await clerkClient.users.updateUserMetadata(userId, {
        privateMetadata: {
          free_usage: free_usage + 1,
        },
      });
    }

    res.json({ success: true, content });
  } catch (error) {
    console.error("Error generating blog Title:", error);
    res
      .status(500)
      .json({ success: false, message: "Error generating blog title" });
  }
};

export const generateImage = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, publish } = req.body;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is available for premium plan users only",
      });
    }

    const formData = new FormData();
    formData.append("prompt", prompt);
    const { data } = await axios.post(
      "https://clipdrop-api.co/text-to-image/v1",
      formData,
      {
        headers: {
          "x-api-key": process.env.CLIPDROP_API_KEY,
        },
        responseType: "arraybuffer",
      },
    );
    console.log(data.length);
    const buffer = Buffer.from(data, "binary");

    const { secure_url } = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(  //upload_stream() is callback-based. Wrapping it in a Promise allows me to use async/await, making the code  cleaner and easier to read.
        { resource_type: "image" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        },
      );

      stream.end(buffer);
    });
    await sql`INSERT INTO creations (user_id , prompt , content , type , publish) VALUES (${userId} , ${prompt} , ${secure_url} , 'image' , ${publish ?? false})`;

    res.json({ success: true, content: secure_url });
  } catch (error) {
    console.error("Error generating Image:", error);
    res.status(500).json({ success: false, message: "Error generating image" });
  }
};

export const removeImageBackground = async (req, res) => {
  try {
    const { userId } = req.auth();
    // FIXED: Removed the destructuring curly braces
    const image = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is available for premium plan users only",
      });
    }

    // Now image.path will correctly point to the uploaded file's temporary path
    const { secure_url } = await cloudinary.uploader.upload(image.path, {
      transformation: [
        {
          effect: "background_removal",
          background_removal: "remove_the_background",
        },
      ],
    });

    await sql`INSERT INTO creations (user_id , prompt , content , type) VALUES (${userId} , 'Remove background from the image' , ${secure_url} , 'image')`;

    res.json({ success: true, content: secure_url });
  } catch (error) {
    console.error("Error removing Image Background:", error);
    res
      .status(500)
      .json({ success: false, message: "Error removing the background" });
  }
};

export const removeImageObject = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { object } = req.body;
    // FIXED: Removed the destructuring curly braces around image
    const image = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is available for premium plan users only",
      });
    }

    // Now image.path will correctly map to the uploaded file's temp path
    const { public_id } = await cloudinary.uploader.upload(image.path);

    const imageUrl = cloudinary.url(public_id, {
      transformation: [
        {
          effect: `gen_remove:${object}`,
        },
      ],
      resource_type: "image",
    });

    await sql`INSERT INTO creations (user_id , prompt , content , type) VALUES (${userId} , ${`Removed ${object} from image`} , ${imageUrl} , 'image')`;

    res.json({ success: true, content: imageUrl });
  } catch (error) {
    console.error("Error Removing Object from the Image:", error);
    res.status(500).json({
      success: false,
      message: "Error removing Object from the Image",
    });
  }
};

export const resumeReview = async (req, res) => {
  try {
    const { userId } = req.auth();
    const resume = req.file;
    const plan = req.plan;

    if (plan !== "premium") {
      return res.json({
        success: false,
        message: "This feature is available for premium plan users only",
      });
    }

    if (resume.size > 5 * 1024 * 1024) {
      return res.json({
        success: false,
        message: "File size should be less than 5MB",
      });
    }

    const dataBuffer = fs.readFileSync(resume.path);

    // FIXED: Using the modern PDFParse class syntax
    const parser = new PDFParse({
      data: new Uint8Array(dataBuffer),
      CanvasFactory,
    });

    // Extract the text asynchronously
    const pdfData = await parser.getText();

    const prompt = `Review the following resume and provide constructive feedback on its strengths, weakness, and areas for improvements. Resume Content : \n\n${pdfData.text}`;
    // FIXED: Replaced OpenAI call with correct Gemini SDK syntax
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", // Using a valid, current model
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      config: {
        temperature: 0.7,
        // maxOutputTokens: 1000,
      },
    });

    // FIXED: Correctly extracting the text from the Gemini response
    const content = response.text;

    await sql`INSERT INTO creations (user_id , prompt , content , type) VALUES (${userId} ,'Review the uploaded resume' , ${content} , 'resume-review')`;

    res.json({ success: true, content });
  } catch (error) {
    console.error("Error Reviewing Resume:", error);
    res.status(500).json({
      success: false,
      message: "Error while reviewing the resume",
    });
  }
};
