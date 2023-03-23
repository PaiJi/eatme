import tinify from "tinify";
import fs from "fs";
import path from "path";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as dotenv from "dotenv";
dotenv.config();

const DirPath = process.env.IMAGES_FOLDER;
const BUCKET_NAME = process.env.S3_BUCKET;
tinify.key = process.env.TINIFY_API_KEY;

const S3_REGION = process.env.S3_REGION;
const S3_PREFIX = process.env.S3_PREFIX;
const ENDPOINT = process.env.S3_ENDPOINT;
const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const tinifyAvaliableExtensions = [".jpg", ".jpeg", ".png", ".webp"];

const S3 = new S3Client({
  region: S3_REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

async function main(targetFolder) {
  const imageFiles = getAllImages(targetFolder);
  const afterRemoveExistingFiles = await removeExistingFiles(imageFiles);
  await initOutoutDir();
  const waitUploadFiles = await convertImages(afterRemoveExistingFiles);
  // await uploadFiles(waitUploadFiles);
}

function getAllImages(directoryPath) {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".svg", ".gif"];
  const imageFiles = [];

  // 读取目录中的所有文件和子目录
  const files = fs.readdirSync(directoryPath);

  files.forEach((file) => {
    const filePath = path.join(directoryPath, file);
    const fileStat = fs.statSync(filePath);

    // 如果是目录，则递归查找里面的图片文件
    if (fileStat.isDirectory()) {
      const subDirectoryFiles = getAllImages(filePath);
      imageFiles.push(...subDirectoryFiles);
    } else {
      // 如果是文件，并且是图片文件，则加入结果数组中
      if (imageExtensions.includes(path.extname(filePath).toLowerCase())) {
        imageFiles.push(filePath);
      }
    }
  });

  return imageFiles;
}

function getBuildS3FileKey(filePath, split = "/") {
  const parentFolderNames = getAllParentFolderNames(filePath);
  const fileInfo = path.parse(filePath);
  const fileName = fileInfo.name;
  const fileExtension = path.extname(filePath).toLocaleLowerCase();

  let buildS3FileKey = parentFolderNames
    .join(split)
    .concat(split)
    .concat(fileName);

  if (tinifyAvaliableExtensions.includes(fileExtension)) {
    // 白名单中的扩展名最后都会被转换成webp，因此用webp去S3中尝试匹配
    buildS3FileKey = buildS3FileKey.concat(".webp");
  } else {
    // 否则直接上传
    buildS3FileKey = buildS3FileKey.concat(fileExtension);
  }

  return buildS3FileKey;
}

async function removeExistingFiles(imageFiles) {
  const afterRemovedExistingFiles = [];

  const S3BucketFileNames = await getBucketFileList();
  imageFiles.forEach((filePath) => {
    const buildedS3FileKey = getBuildS3FileKey(filePath);

    if (S3BucketFileNames.includes(buildedS3FileKey)) {
      console.log(`${buildedS3FileKey} file already exists, skip`);
    } else {
      afterRemovedExistingFiles.push(filePath);
    }
  });

  return afterRemovedExistingFiles;
}

async function convertImages(imageFiles) {
  //如果是白名单中的文件，调用接口压缩、转换、输出到output目录，否则直接返回路径
  const convertedImages = [];
  for (const imageFile of imageFiles) {
    try {
      const fileExtension = path.extname(imageFile).toLocaleLowerCase();
      const buildS3FileKey = getBuildS3FileKey(imageFile, "/");

      if (tinifyAvaliableExtensions.includes(fileExtension)) {
        const localOutputFileName = getBuildS3FileKey(imageFile, ":");
        const filePath = await processImage(
          imageFile,
          localOutputFileName,
          fileExtension !== ".webp"
        );
        convertedImages.push({ S3FikeKey: buildS3FileKey, filePath: filePath });
        await uploadFile(filePath, buildS3FileKey);
      } else {
        // 否则直接上传
        convertedImages.push({
          S3FikeKey: buildS3FileKey,
          filePath: imageFile,
        });
        await uploadFile(imageFile, buildS3FileKey);
      }
    } catch (error) {
      console.error(error);
    }
  }

  return convertedImages;
}

async function initOutoutDir() {
  const folderName = "./output";
  try {
    // 检测目录是否存在
    await fs.promises.stat(folderName);
    // 目录存在，删除目录
    await fs.promises.rmdir(folderName, { recursive: true });
    console.log(`Folder ${folderName} deleted successfully`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      // 目录存在不需要创建，出现其他错误
      console.error(`Error checking directory: ${err}`);
      return;
    }
  }

  // 新建目录
  await fs.promises.mkdir(folderName);
  console.log(`Folder ${folderName} created successfully`);
}

async function processImage(filePath, newFileNameForS3, needConvert = false) {
  // Due to tinyPng rate limit we need to wait a bit before uploading.
  await new Promise((r) => setTimeout(r, 10000));
  console.log(`${newFileNameForS3} start processing...`);
  const source = tinify.fromFile(filePath);
  if (needConvert) {
    const converted = source.convert({ type: ["image/webp"] });
    await converted.toFile(`./output/${newFileNameForS3}`);
  } else {
    await source.toFile(`./output/${newFileNameForS3}`);
  }

  console.log(`${newFileNameForS3} processing completed`);
  return `./output/${newFileNameForS3}`;
}

async function uploadFiles(imageFiles) {
  for (const imageFile of imageFiles) {
    await uploadFile(imageFile.filePath, imageFile.S3FikeKey);
  }
}

async function uploadFile(filePath, fileKey) {
  const fileExtension = path.extname(filePath).toLocaleLowerCase();
  await S3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
      Body: fs.readFileSync(filePath),
      ContentType: fileExtension,
    })
  );
  console.log(`${fileKey} uploaded successfully`);
}

function getAllParentFolderNames(filePath) {
  const parentFolderPath = path.dirname(filePath);
  if (parentFolderPath === DirPath) {
    return [];
  }

  const parentFolderName = path.basename(parentFolderPath);
  const parentFolderNames = getAllParentFolderNames(parentFolderPath);

  return [...parentFolderNames, parentFolderName];
}

async function getBucketFileList() {
  const bucketListResponse = await S3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: S3_PREFIX,
    })
  );
  const bucketList =
    bucketListResponse.Contents.map((content) => content.Key) || [];
  return bucketList;
}

if (DirPath) {
  main(DirPath);
} else {
  throw new Error("Please provide a file name");
}
