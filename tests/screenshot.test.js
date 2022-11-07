import child_process from "child_process";
import fs from "fs";

function isCaptureFound(screenshotsDirPath) {
  const warcLists = fs.readdirSync(screenshotsDirPath);
  var captureFound = 0;
  for (var i = 0; i < warcLists.length; i++) {
    if (warcLists[i].endsWith(".warc.gz")){
      captureFound = 1;
    }
  }
  return captureFound;
}

// screenshot

test("ensure basic crawl run with --screenshot passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection test --url http://www.example.com/ --screenshot --workers 2");
});

test("check that a screenshots warc file exists in the test collection", () => {
  let captureFound = isCaptureFound("test-crawls/collections/test/screenshots/");
  expect(captureFound).toEqual(1);
});

// fullPageScreenshot

test("ensure basic crawl run with --fullPageScreenshot passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection fullpage --url http://www.example.com/ --fullPageScreenshot --workers 2");
});

test("check that a screenshots warc file exists in the fullpage collection", () => {
  let captureFound = isCaptureFound("test-crawls/collections/fullpage/screenshots/");
  expect(captureFound).toEqual(1);
});

// thumbnail

test("ensure basic crawl run with --thumbnail passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection thumbnail --url http://www.example.com/ --thumbnail --workers 2");
});

test("check that a screenshots warc file exists in the thumbnail collection", () => {
  let captureFound = isCaptureFound("test-crawls/collections/thumbnail/screenshots/");
  expect(captureFound).toEqual(1);
});

// combination

test("ensure basic crawl run with multiple screenshot types and --generateWACZ passes", async () => {
  child_process.execSync("docker run -v $PWD/test-crawls:/crawls webrecorder/browsertrix-crawler crawl --collection combined --url http://www.example.com/ --thumbnail --screenshot --fullPageScreenshot --generateWACZ --workers 2");
});

test("check that a screenshots warc file exists in the combined collection", () => {
  let captureFound = isCaptureFound("test-crawls/collections/combined/screenshots/");
  expect(captureFound).toEqual(1);
});

test("check that a wacz file exists in the combined collection", () => {
  const waczExists = fs.existsSync("test-crawls/collections/combined/combined.wacz");
  expect(waczExists).toBe(true);
});
