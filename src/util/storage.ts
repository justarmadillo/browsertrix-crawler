import child_process from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import util from "util";

import os from "os";
import { createHash } from "crypto";

import * as Minio from "minio";

import { initRedis } from "./redis.js";
import { logger } from "./logger.js";

// @ts-expect-error (incorrect types on get-folder-size)
import getFolderSize from "get-folder-size";

import { WACZ } from "./wacz.js";

const DEFAULT_REGION = "us-east-1";

// ===========================================================================
export class S3StorageSync {
  fullPrefix: string;
  client: Minio.Client;

  bucketName: string;
  objectPrefix: string;
  resources: object[] = [];

  userId: string;
  crawlId: string;
  webhookUrl?: string;

  // TODO: Fix this the next time the file is edited.

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    urlOrData: string | any,
    {
      webhookUrl,
      userId,
      crawlId,
    }: { webhookUrl?: string; userId: string; crawlId: string },
  ) {
    let url;
    let accessKey;
    let secretKey;

    if (typeof urlOrData === "string") {
      url = new URL(urlOrData);
      accessKey = url.username;
      secretKey = url.password;
      url.username = "";
      url.password = "";
      this.fullPrefix = url.href;
    } else {
      url = new URL(urlOrData.endpointUrl);
      accessKey = urlOrData.accessKey;
      secretKey = urlOrData.secretKey;
      this.fullPrefix = url.href;
    }

    const region = process.env.STORE_REGION || DEFAULT_REGION;

    this.client = new Minio.Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
      partSize: 100 * 1024 * 1024,
      region,
    });

    this.bucketName = url.pathname.slice(1).split("/")[0];

    this.objectPrefix = url.pathname.slice(this.bucketName.length + 2);

    this.resources = [];

    this.userId = userId;
    this.crawlId = crawlId;
    this.webhookUrl = webhookUrl;
  }

  async uploadStreamingWACZ(wacz: WACZ, targetFilename: string) {
    const fileUploadInfo = {
      bucket: this.bucketName,
      crawlId: this.crawlId,
      prefix: this.objectPrefix,
      targetFilename,
    };
    logger.info("S3 file upload information", fileUploadInfo, "storage");

    const waczStream = wacz.generate();

    await this.client.putObject(
      this.bucketName,
      this.objectPrefix + targetFilename,
      waczStream,
    );

    const hash = wacz.getHash();
    const path = targetFilename;

    const size = wacz.getSize();

    // for backwards compatibility, keep 'bytes'
    return { path, size, hash, bytes: size };
  }

  async uploadFile(srcFilename: string, targetFilename: string) {
    const fileUploadInfo = {
      bucket: this.bucketName,
      crawlId: this.crawlId,
      prefix: this.objectPrefix,
      targetFilename,
    };
    logger.info("S3 file upload information", fileUploadInfo, "storage");

    await this.client.fPutObject(
      this.bucketName,
      this.objectPrefix + targetFilename,
      srcFilename,
    );

    const hash = await checksumFile("sha256", srcFilename);
    const path = targetFilename;

    const size = await getFileSize(srcFilename);

    // for backwards compatibility, keep 'bytes'
    return { path, size, hash, bytes: size };
  }

  async downloadFile(srcFilename: string, destFilename: string) {
    await this.client.fGetObject(
      this.bucketName,
      this.objectPrefix + srcFilename,
      destFilename,
    );
  }

  async uploadCollWACZ(
    srcOrWACZ: string | WACZ,
    targetFilename: string,
    completed = true,
  ) {
    const resource =
      typeof srcOrWACZ === "string"
        ? await this.uploadFile(srcOrWACZ, targetFilename)
        : await this.uploadStreamingWACZ(srcOrWACZ, targetFilename);

    logger.info(
      "WACZ S3 file upload resource",
      { targetFilename, resource },
      "storage",
    );

    if (this.webhookUrl) {
      const body = {
        id: this.crawlId,
        user: this.userId,

        //filename: `s3://${this.bucketName}/${this.objectPrefix}${this.waczFilename}`,
        filename: this.fullPrefix + targetFilename,

        ...resource,
        completed,
      };

      logger.info(`Pinging Webhook: ${this.webhookUrl}`);

      if (
        this.webhookUrl.startsWith("http://") ||
        this.webhookUrl.startsWith("https://")
      ) {
        await fetch(this.webhookUrl, {
          method: "POST",
          body: JSON.stringify(body),
        });
      } else if (this.webhookUrl.startsWith("redis://")) {
        const parts = this.webhookUrl.split("/");
        if (parts.length !== 5) {
          logger.fatal(
            "redis webhook url must be in format: redis://<host>:<port>/<db>/<key>",
            {},
            "redis",
          );
        }
        const redis = await initRedis(parts.slice(0, 4).join("/"));
        await redis.rpush(parts[4], JSON.stringify(body));
      }
    }
  }
}

export function initStorage() {
  if (!process.env.STORE_ENDPOINT_URL) {
    return null;
  }

  const endpointUrl =
    process.env.STORE_ENDPOINT_URL + (process.env.STORE_PATH || "");
  const storeInfo = {
    endpointUrl,
    accessKey: process.env.STORE_ACCESS_KEY,
    secretKey: process.env.STORE_SECRET_KEY,
  };

  const opts = {
    crawlId: process.env.CRAWL_ID || os.hostname(),
    webhookUrl: process.env.WEBHOOK_URL || "",
    userId: process.env.STORE_USER || "",
  };

  logger.info("Initing Storage...");
  return new S3StorageSync(storeInfo, opts);
}

export async function getFileSize(filename: string) {
  const stats = await fsp.stat(filename);
  return stats.size;
}

export async function getDirSize(dir: string): Promise<number> {
  const { size, errors } = await getFolderSize(dir);
  if (errors && errors.length) {
    logger.warn("Size check errors", { errors }, "storage");
  }
  return size;
}

export async function isDiskFull(collDir: string) {
  const diskUsage: Record<string, string> = await getDiskUsage(collDir);
  const usedPercentage = parseInt(diskUsage["Use%"].slice(0, -1));
  return usedPercentage >= 99;
}

export async function checkDiskUtilization(
  collDir: string,
  // TODO: Fix this the next time the file is edited.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>,
  archiveDirSize: number,
  dfOutput = null,
  doLog = true,
) {
  const diskUsage: Record<string, string> = await getDiskUsage(
    collDir,
    dfOutput,
  );
  const usedPercentage = parseInt(diskUsage["Use%"].slice(0, -1));

  // Check that disk usage isn't already above threshold
  if (usedPercentage >= params.diskUtilization) {
    if (doLog) {
      logger.info(
        `Disk utilization threshold reached ${usedPercentage}% > ${params.diskUtilization}%, stopping`,
      );
    }
    return {
      stop: true,
      used: usedPercentage,
      projected: null,
      threshold: params.diskUtilization,
    };
  }

  // Check that disk usage isn't likely to cross threshold
  const kbUsed = parseInt(diskUsage["Used"]);
  const kbTotal = parseInt(diskUsage["1K-blocks"]);

  let kbArchiveDirSize = Math.round(archiveDirSize / 1024);

  // assume if has STORE_ENDPOINT_URL, will be uploading to remote
  // and not storing local copy of either WACZ or WARC
  if (!process.env.STORE_ENDPOINT_URL) {
    if (params.combineWARC && params.generateWACZ) {
      kbArchiveDirSize *= 4;
    } else if (params.combineWARC || params.generateWACZ) {
      kbArchiveDirSize *= 2;
    }
  }

  const projectedTotal = kbUsed + kbArchiveDirSize;
  const projectedUsedPercentage = calculatePercentageUsed(
    projectedTotal,
    kbTotal,
  );

  if (projectedUsedPercentage >= params.diskUtilization) {
    if (doLog) {
      logger.info(
        `Disk utilization projected to reach threshold ${projectedUsedPercentage}% > ${params.diskUtilization}%, stopping`,
      );
    }
    return {
      stop: true,
      used: usedPercentage,
      projected: projectedUsedPercentage,
      threshold: params.diskUtilization,
    };
  }

  return {
    stop: false,
    used: usedPercentage,
    projected: projectedUsedPercentage,
    threshold: params.diskUtilization,
  };
}

export async function getDFOutput(path: string) {
  const exec = util.promisify(child_process.exec);
  const res = await exec(`df ${path}`);
  return res.stdout;
}

export async function getDiskUsage(path = "/crawls", dfOutput = null) {
  const result = dfOutput || (await getDFOutput(path));
  const lines = result.split("\n");
  const keys = lines[0].split(/\s+/gi);
  const rows = lines.slice(1).map((line) => {
    const values = line.split(/\s+/gi);
    // TODO: Fix this the next time the file is edited.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return keys.reduce((o: Record<string, any>, k, index) => {
      o[k] = values[index];
      return o;
    }, {});
  });
  return rows[0];
}

export function calculatePercentageUsed(used: number, total: number) {
  return Math.round((used / total) * 100);
}

function checksumFile(hashName: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(hashName);

    const stream = fs.createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function interpolateFilename(filename: string, crawlId: string) {
  filename = filename.replace(
    "@ts",
    new Date().toISOString().replace(/[:TZz.-]/g, ""),
  );
  filename = filename.replace("@hostname", os.hostname());
  filename = filename.replace("@hostsuffix", os.hostname().slice(-14));
  filename = filename.replace("@id", crawlId);
  return filename;
}
