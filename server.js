require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const ytdl = require("ytdl-core");
const AWS = require("aws-sdk");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const app = express();
const cors = require("cors");
app.use(cors());
app.use(express.json());

const client = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_KEY,
  },
});

let objectUrl = "";
let Key = "";
const Bucket = process.env.BUCKET_NAME;
const newBucket = process.env.NEW_BUCKET_NAME; // Update with your new bucket name
let pname = "";

// Set the AWS region here
AWS.config.update({ region: "ap-south-1" }); // Replace 'eu-north-1' with your desired region

const s3 = new AWS.S3({
  accessKeyId: process.env.ACCESS_KEY,
  secretAccessKey: process.env.SECRET_KEY,
});

const transcribe = new AWS.TranscribeService({
  accessKeyId: process.env.ACCESS_KEY,
  secretAccessKey: process.env.SECRET_KEY,
  region: process.env.AWS_REGION,
});

const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const readFile = async (bucket, key) => {
  const params = {
    Bucket: bucket,
    Key: key,
  };

  const command = new GetObjectCommand(params);
  const response = await client.send(command);

  const { Body } = response;

  return streamToString(Body);
};

app.post("/transcribe", async (req, res) => {
  const { name, link, source } = req.body;
  pname = name;

  if (source !== "Youtube") {
    return res.status(400).send("Only YouTube links are supported");
  }

  try {
    const audioStream = ytdl(link, {
      filter: "audioonly",
      quality: "highestaudio",
    });
    const s3Params = {
      Bucket: process.env.BUCKET_NAME,
      Key: `audio_${uuidv4()}.mp3`,
      Body: audioStream,
      ContentType: "audio/mpeg",
    };

    s3.upload(s3Params, (err, data) => {
      if (err) {
        console.error("Error uploading to S3", err);
        return res.status(500).send("Error uploading to S3");
      }

      const jobName = `transcription_${uuidv4()}`;
      const transcribeParams = {
        TranscriptionJobName: jobName,
        Media: { MediaFileUri: data.Location },
        MediaFormat: "mp3",
        LanguageCode: "en-US",
        OutputBucketName: process.env.BUCKET_NAME,
      };

      transcribe.startTranscriptionJob(transcribeParams, (err, transcribeData) => {
        if (err) {
          console.error("Error starting transcription job", err);
          return res.status(500).send("Error starting transcription job");
        }

        const intervalId = setInterval(() => {
          transcribe.getTranscriptionJob({ TranscriptionJobName: jobName }, (err, transcribeResult) => {
            if (err) {
              clearInterval(intervalId);
              console.error("Error getting transcription job", err);
              return res.status(500).send("Error getting transcription job");
            }

            if (transcribeResult.TranscriptionJob.TranscriptionJobStatus === "COMPLETED") {
              clearInterval(intervalId);
              const transcriptionUrl = transcribeResult.TranscriptionJob.Transcript.TranscriptFileUri;
              const urlParts = transcriptionUrl.split("/");
              Key = urlParts.pop();




              s3.getObject({ Bucket, Key }, function (err, data) {
                if (err) {
                  console.log(err, err.stack);
                } else {
                  const dummy = JSON.parse(data.Body.toString("ascii"));
                  const transcripted = dummy.results.transcripts[0].transcript;
                  const currentDate = new Date().toLocaleString("en-US", {
                    day: "numeric",
                    month: "short",
                    year: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const newData = {
                    name: pname,
                    upload_date: new Date(),
                    transcripted: transcripted,
                    status: "Done"
                  };
                  const newKey = `transcription_${uuidv4()}.json`;
                  const uploadParams = {
                    Bucket: newBucket,
                    Key: newKey,
                    Body: JSON.stringify(newData),
                    ContentType: "application/json",
                  };
                  s3.upload(uploadParams, (err, data) => {
                    if (err) {
                      console.error("Error uploading to new bucket", err);
                    } else {
                      console.log("Uploaded to new bucket:", data.Location);
                    }
                  });
                }
              });

              res.json({ transcriptionUrl });
            }
          });
        }, 10000);
      });
    });
  } catch (error) {
    console.error("Error downloading audio", error);
    return res.status(500).send("Error downloading audio");
  }
});

app.get("/transcriptions", async (req, res) => {
  try {
    const params = {
      Bucket: newBucket,
      Prefix: "transcription_",
    };

    const command = new ListObjectsV2Command(params);
    const response = await client.send(command);

    const transcriptions = await Promise.all(
      response.Contents.map(async (item) => {
        let docid = item.Key.split("_")[1];
        docid = docid.split(".")[0];
        const data = await readFile(newBucket, item.Key);
        console.log(docid)
        const desired = {...JSON.parse(data), docid:docid}
        return desired;
      })
    );

    res.json(transcriptions);
  } catch (error) {
    console.error("Error fetching transcriptions", error);
    res.status(500).send("Error fetching transcriptions");
  }
});

app.get("/transcriptions/:id", async (req, res) => {
  try {

    const { id } = req.params;
    console.log(id)
    const params = {
      Bucket: newBucket,
      Key: `transcription_${id}.json`,
    };

    const command = new GetObjectCommand(params);
    const response = await client.send(command);
    const data = await streamToString(response.Body);

    res.json(JSON.parse(data));
  } catch (error) {
    console.error("Error fetching transcription", error);
    res.status(500).send("Error fetching transcription");
  }
});

app.put("/transcriptions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, transcripted } = req.body;

    const params = {
      Bucket: newBucket,
      Key: `transcription_${id}.json`,
    };

    const command = new GetObjectCommand(params);
    const response = await client.send(command);
    let data = JSON.parse(await streamToString(response.Body));

    if (name) data.name = name;
    if (transcripted) data.transcripted = transcripted;

    const uploadParams = {
      Bucket: newBucket,
      Key: `transcription_${id}.json`,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    };

    s3.upload(uploadParams, (err, data) => {
      if (err) {
        console.error("Error updating transcription", err);
        res.status(500).send("Error updating transcription");
      } else {
        console.log("Transcription updated successfully");
        res.status(200).send("Transcription updated successfully");
      }
    });
  } catch (error) {
    console.error("Error updating transcription", error);
    res.status(500).send("Error updating transcription");
  }
});

app.delete("/transcriptions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const params = {
      Bucket: newBucket,
      Key: `transcription_${id}.json`,
    };

    const command = new GetObjectCommand(params);
    const response = await client.send(command);

    if (!response) {
      console.error("Transcription not found");
      res.status(404).send("Transcription not found");
      return;
    }

    const deleteParams = {
      Bucket: newBucket,
      Key: `transcription_${id}.json`,
    };

    s3.deleteObject(deleteParams, (err, data) => {
      if (err) {
        console.error("Error deleting transcription", err);
        res.status(500).send("Error deleting transcription");
      } else {
        console.log("Transcription deleted successfully");
        res.status(200).send("Transcription deleted successfully");
      }
    });
  } catch (error) {
    console.error("Error deleting transcription", error);
    res.status(500).send("Error deleting transcription");
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
