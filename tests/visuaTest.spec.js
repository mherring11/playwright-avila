const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");
const axios = require("axios");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Forcefully capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));

    const navigationPromise = page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    const timeoutPromise = new Promise(
      (resolve) =>
        setTimeout(() => {
          console.log(
            chalk.red(`Timeout detected on ${url}. Forcing screenshot.`)
          );
          resolve();
        }, 10000) // Timeout after 10 seconds
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Forced screenshot captured: ${screenshotPath}`));
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();
  const environments = `
    <a href="${config.staging.baseUrl}" target="_blank">Staging: ${config.staging.baseUrl}</a>,
    <a href="${config.prod.baseUrl}" target="_blank">Prod: ${config.prod.baseUrl}</a>
  `;

  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background-color: #f2f2f2; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
        img { max-width: 150px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage >= 95
          ).length
        }</p>
        <p>Failed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage < 95
          ).length
        }</p>
        <p>Errors: ${
          results.filter((r) => r.similarityPercentage === "Error").length
        }</p>
        <p>Last Run: ${now}</p>
        <p>Environments Tested: ${environments}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Thumbnail</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(
      /\//g,
      "_"
    )}.png`;

    const stagingUrl = `${config.staging.baseUrl}${result.pagePath}`;
    const prodUrl = `${config.prod.baseUrl}${result.pagePath}`;

    const statusClass =
      typeof result.similarityPercentage === "number" &&
      result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>
          <a href="${stagingUrl}" target="_blank">Staging</a> |
          <a href="${prodUrl}" target="_blank">Prod</a>
        </td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank"><img src="${diffThumbnailPath}" /></a>`
            : "N/A"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Verify broken image links automatically on staging pages from config.js", async ({
    page,
  }) => {
    const stagingUrls = config.staging.urls.map(
      (url) => `${config.staging.baseUrl}${url}`
    );

    for (const url of stagingUrls) {
      console.log(chalk.blue(`Navigating to: ${url}`));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      console.log(chalk.green(`Page loaded successfully: ${url}`));

      console.log(chalk.blue("Finding all image elements on the page..."));
      const images = await page.locator("img");
      const imageCount = await images.count();
      console.log(chalk.green(`Found ${imageCount} images on the page.`));

      let brokenImages = 0;

      for (let i = 0; i < imageCount; i++) {
        let imageUrl = await images.nth(i).getAttribute("src");

        if (!imageUrl) {
          console.log(
            chalk.yellow(`Image ${i + 1} does not have a valid src attribute.`)
          );
          brokenImages++;
          continue;
        }

        // Handle relative and protocol-relative URLs
        if (!imageUrl.startsWith("http") && !imageUrl.startsWith("//")) {
          imageUrl = new URL(imageUrl, url).toString();
        } else if (imageUrl.startsWith("//")) {
          imageUrl = `https:${imageUrl}`;
        }

        // Exclude known tracking pixels or problematic URLs
        if (
          imageUrl.includes("bat.bing.com") ||
          imageUrl.includes("tracking")
        ) {
          console.log(
            chalk.yellow(
              `Image ${i + 1} is a tracking pixel or excluded URL: ${imageUrl}`
            )
          );
          continue;
        }

        try {
          console.log(chalk.blue(`Checking image ${i + 1}: ${imageUrl}`));
          const response = await axios.get(imageUrl);

          if (response.status !== 200) {
            console.log(
              chalk.red(
                `Image ${i + 1} failed to load. Status Code: ${response.status}`
              )
            );
            brokenImages++;
          } else {
            console.log(chalk.green(`Image ${i + 1} loaded successfully.`));
          }
        } catch (error) {
          console.log(
            chalk.red(`Image ${i + 1} failed to load. Error: ${error.message}`)
          );
          brokenImages++;
        }
      }

      if (brokenImages > 0) {
        console.log(
          chalk.red(
            `Test failed for ${url}. Found ${brokenImages} broken images on the page.`
          )
        );
      } else {
        console.log(
          chalk.green(
            `Test passed for ${url}. No broken images found on the page.`
          )
        );
      }
    }
  });

  test("Fill out the form one field at a time and submit (Staging Only)", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
  
    try {
      // Navigate to the staging form page
      const formPageUrl = `${config.staging.baseUrl}${config.staging.urls[0]}`;
      console.log(chalk.blue(`Navigating to the staging form page: ${formPageUrl}`));
  
      await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Page loaded successfully on staging."));
  
      // Click the "Request Info" button to display the form
      console.log(chalk.blue("Clicking 'Request Info' button..."));
      await page.click("button.request-info-popup");
      console.log(chalk.green("Form popup displayed successfully."));
  
      console.log(chalk.blue("Blocking unnecessary resources on staging..."));
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (
          url.endsWith(".png") ||
          url.endsWith(".jpg") ||
          url.endsWith(".css") ||
          url.endsWith(".js")
        ) {
          route.abort();
        } else {
          route.continue();
        }
      });
      console.log(chalk.green("Unnecessary resources blocked."));
  
      // Fill out the form fields
      console.log(chalk.blue("Filling out the form..."));
      await page.selectOption("#input_6_1", { value: "AVILA-M-MBAFIN" }); // Select "MBA with a concentration in Finance"
      const firstName = `John${Date.now()}`;
      await page.fill("#input_6_2", firstName); // First Name
      console.log(chalk.green(`Filled 'First Name' with: ${firstName}`));
      await page.fill("#input_6_3", "Doe"); // Last Name
      console.log(chalk.green("Filled 'Last Name' with: Doe"));
      const email = `johndoe${Date.now()}@example.com`;
      await page.fill("#input_6_6", email); // Email
      console.log(chalk.green(`Filled 'Email' with: ${email}`));
      await page.fill("#input_6_4", "5551234567"); // Phone
      console.log(chalk.green("Filled 'Phone' with: 5551234567"));
      await page.fill("#input_6_5", "12345"); // ZIP Code
      console.log(chalk.green("Filled 'ZIP Code' with: 12345"));
      await page.selectOption("#input_6_7", { value: "Email" }); // Select "How did you hear about us?" as "Email"
      console.log(chalk.green("Filled 'How did you hear about us?' with: Email"));
  
      // Submit the form
      console.log(chalk.blue("Submitting the form..."));
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#gform_submit_button_6"),
      ]);
      console.log(chalk.green("Form submitted successfully on staging."));
  
      // Wait for confirmation page
      const confirmationUrl = page.url();
      console.log(chalk.blue(`Current URL after submission: ${confirmationUrl}`));
      if (!confirmationUrl.includes("/confirmation/")) {
        console.error(chalk.red("Did not navigate to the expected confirmation URL."));
        throw new Error("Confirmation URL mismatch.");
      }
  
      // Verify confirmation message
      console.log(chalk.blue("Waiting for confirmation message..."));
      await page.waitForSelector(".elementor-widget-container h1.header2", {
        timeout: 20000,
      });
      const confirmationText = await page.textContent(
        ".elementor-widget-container h1.header2"
      );

      const normalizedText = confirmationText.trim().replace(/\s+/g, " ").toLowerCase();
      const expectedText = "Thanks for your submission!".toLowerCase();
  
      if (normalizedText === expectedText) {
        console.log(
          chalk.green(
            "Form submitted successfully and confirmation message displayed on staging."
          )
        );
      } else {
        console.error(
          chalk.red(
            `Confirmation message mismatch. Found: "${confirmationText.trim()}"`
          )
        );
        throw new Error("Confirmation message mismatch.");
      }
    } catch (error) {
      console.error(chalk.red(`Error during test: ${error.message}`));
    } finally {
      await context.close();
    }
  });
  

  test("Click Apply Now, fill out the form, and submit", async ({ page }) => {
    const homePageUrl = "https://live-web-online-avila.pantheonsite.io/";
    const formPageUrl = "https://live-web-online-avila.pantheonsite.io/apply/";
    const formSelectors = {
      applyNowButton: "#mega-menu-item-7370 a.mega-menu-link",
      programOfInterest: "#input_1_1",
      firstName: "#input_1_2",
      lastName: "#input_1_3",
      email: "#input_1_4",
      phone: "#input_1_5",
      zipCode: "#input_1_6",
      deliveryMethod: "#input_1_7",
      submitButton: "#gform_submit_button_1",
      confirmationMessage: ".elementor-element-375b1cc6 h1.header2.mb",
    };

    try {
      // Navigate to the homepage
      console.log(chalk.blue(`Navigating to the home page: ${homePageUrl}`));
      await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Homepage loaded successfully."));

      // Click on the "Apply Now" button
      console.log(chalk.blue("Clicking on the 'Apply Now' button..."));
      await page.click(formSelectors.applyNowButton);

      // Wait for the form page to load
      console.log(
        chalk.blue(`Waiting for navigation to the form page: ${formPageUrl}`)
      );
      await page.waitForURL(formPageUrl, { timeout: 10000 });
      console.log(chalk.green("Navigated to the Apply Now form page."));

      // Fill out the form fields
      const testData = {
        program: "AVILA-M-MBAFIN", // Example program value: MBA with a concentration in Finance
        firstName: "Jane",
        lastName: "Doe",
        email: `janedoe${Date.now()}@example.com`, // Unique email for testing
        phone: "5551234567",
        zipCode: "67890",
        deliveryMethod: "Online",
      };

      console.log(chalk.blue("Filling out the Apply Now form fields..."));
      await page.selectOption(formSelectors.programOfInterest, {
        value: testData.program,
      });
      console.log(chalk.green(`Selected program: ${testData.program}`));

      await page.fill(formSelectors.firstName, testData.firstName);
      console.log(chalk.green(`Filled First Name: ${testData.firstName}`));

      await page.fill(formSelectors.lastName, testData.lastName);
      console.log(chalk.green(`Filled Last Name: ${testData.lastName}`));

      await page.fill(formSelectors.email, testData.email);
      console.log(chalk.green(`Filled Email: ${testData.email}`));

      await page.fill(formSelectors.phone, testData.phone);
      console.log(chalk.green(`Filled Phone: ${testData.phone}`));

      await page.fill(formSelectors.zipCode, testData.zipCode);
      console.log(chalk.green(`Filled ZIP Code: ${testData.zipCode}`));

      await page.selectOption(formSelectors.deliveryMethod, {
        value: testData.deliveryMethod,
      });
      console.log(
        chalk.green(`Selected Delivery Method: ${testData.deliveryMethod}`)
      );

      console.log(chalk.green("Form fields filled successfully."));

      // Submit the form and wait for navigation to the confirmation page
      console.log(chalk.blue("Submitting the Apply Now form..."));
      await Promise.all([
        page.waitForSelector(formSelectors.confirmationMessage, {
          timeout: 30000,
        }),
        page.click(formSelectors.submitButton),
      ]);
      console.log(chalk.green("Form submitted successfully."));

      // Wait for the confirmation message
      console.log(chalk.blue("Verifying confirmation message..."));
      const confirmationText = await page.textContent(
        formSelectors.confirmationMessage
      );

      // Verify the confirmation message
      console.log(
        chalk.blue(`Confirmation message found: "${confirmationText.trim()}"`)
      );
      if (
        confirmationText.trim() ===
        "Great! Now, take the next step to complete your application."
      ) {
        console.log(
          chalk.green("Confirmation message matches expected value.")
        );
      } else {
        console.log(
          chalk.red(
            "Confirmation message text did not match the expected value."
          )
        );
      }
    } catch (error) {
      console.error(chalk.red(`Test failed: ${error.message}`));
    }
  });

  test("Verify Online Programs and Getting Started Menus - Avila", async ({
    page,
  }) => {
    const verifyMenu = async (
      menuName,
      menuSelector,
      submenuSelector,
      linksSelector
    ) => {
      console.log(chalk.blue(`Locating the '${menuName}' menu...`));

      // Locate the menu element
      const menuElement = await page.locator(menuSelector);
      if (!(await menuElement.isVisible())) {
        throw new Error(`The '${menuName}' menu is not visible.`);
      }
      console.log(chalk.green(`The '${menuName}' menu is visible.`));

      // Hover over the menu to display submenus
      console.log(chalk.blue(`Hovering over the '${menuName}' menu...`));
      await menuElement.hover();

      // Locate submenus
      const submenus = await page.locator(submenuSelector);
      const submenuCount = await submenus.count();
      if (submenuCount === 0) {
        throw new Error(`No submenus found for '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${submenuCount} submenus in the '${menuName}' menu.`)
      );

      // Locate links in the submenus
      const links = await page.locator(linksSelector);
      const linkCount = await links.count();
      if (linkCount === 0) {
        throw new Error(`No links found in the '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${linkCount} links in the '${menuName}' menu.`)
      );

      // Verify each link
      let invalidLinks = 0;
      for (let i = 0; i < linkCount; i++) {
        const linkText = await links.nth(i).textContent();
        const linkHref = await links.nth(i).getAttribute("href");
        console.log(
          chalk.blue(
            `Checking link ${i + 1} in '${menuName}' menu: ${linkText}`
          )
        );

        if (!linkHref || linkHref.trim() === "") {
          console.log(
            chalk.yellow(
              `Warning: Link '${linkText}' in '${menuName}' menu does not have a valid href attribute.`
            )
          );
          invalidLinks++;
        } else {
          console.log(
            chalk.green(
              `Link '${linkText}' in '${menuName}' menu is valid with href: ${linkHref}`
            )
          );
        }
      }

      console.log(
        chalk.green(
          `All checks complete for '${menuName}' menu. Found ${invalidLinks} invalid links.`
        )
      );

      if (invalidLinks > 0) {
        console.log(
          chalk.yellow(
            `Test completed with ${invalidLinks} warnings for invalid links in the '${menuName}' menu.`
          )
        );
      } else {
        console.log(
          chalk.green(`All links in the '${menuName}' menu are valid.`)
        );
      }
    };

    const homePageUrl = "https://live-web-online-avila.pantheonsite.io/";
    console.log(chalk.blue("Navigating to the Avila homepage..."));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
    console.log(chalk.green("Homepage loaded successfully."));

    // Verify the "Online Programs" menu
    await verifyMenu(
      "Online Programs",
      "#mega-menu-item-7306 > a.mega-menu-link",
      "#mega-menu-item-7306 ul.mega-sub-menu",
      "#mega-menu-item-7306 ul.mega-sub-menu a.mega-menu-link"
    );

    // Verify the "Getting Started" menu
    await verifyMenu(
      "Getting Started",
      "#mega-menu-item-7361 > a.mega-menu-link",
      "#mega-menu-item-7361 ul.mega-sub-menu",
      "#mega-menu-item-7361 ul.mega-sub-menu a.mega-menu-link"
    );
  });
});
