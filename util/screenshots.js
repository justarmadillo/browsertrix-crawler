import fs from "fs";
import path from "path";
import * as warcio from "warcio";


// ============================================================================

function isScreenshotSelected(params) {
  return params.screenshot || params.fullPageScreenshot || params.thumbnail;
}

class Screenshots {

  constructor({page, id, url, date, directory}) {
    this.page = page;
    this.id = id;
    this.url = url;
    this.directory = directory;
    this.warcName = path.join(this.directory, "screenshots-" + this.id + ".warc.gz");
    this.date = date ? date : new Date();
  }

  async take({fullPage = false, imageType = "png"} = {}) {
    let options = {omitBackground: true, fullPage: fullPage, type: imageType};
    let screenshotType = fullPage ? "screenshot-fullpage" : "screenshot";
    if (imageType === "jpeg") {
      screenshotType = "thumbnail";
      options.quality = 75;
    }
    try {
      if (!fullPage) {
        await this.page.setViewport({width: 1920, height: 1080});
      }
      let screenshotBuffer = await this.page.screenshot(options);
      let warcRecord = await this.wrap(screenshotBuffer, screenshotType, imageType);
      let warcRecordBuffer = await warcio.WARCSerializer.serialize(warcRecord, {gzip: true});
      fs.appendFileSync(this.warcName, warcRecordBuffer);
      console.log(`Screenshot (type: ${screenshotType}) for ${this.url} written to ${this.warcName}`);
    } catch (e) {
      console.log(`Taking screenshot (type: ${screenshotType}) failed for ${this.url}`, e);
    }
  }

  async takeFullPage() {
    await this.take({fullPage: true});
  }

  async takeThumbnail() {
    await this.take({imageType: "jpeg"});
  }

  async wrap(buffer, screenshotType="screenshot", imageType="png") {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = {"Content-Type": `image/${imageType}`};
    async function* content() {
      yield buffer;
    }
    let screenshotUrl = `urn:${screenshotType}:` + this.url;
    return warcio.WARCRecord.create({
      url: screenshotUrl,
      date: this.date.toISOString(),
      type: warcRecordType,
      warcVersion,
      warcHeaders}, content());
  }
}

export { Screenshots, isScreenshotSelected };
