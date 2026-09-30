import { requestSentinelHub } from "./sentinelHubClient.js";
const OBSERVABILITY_EVALSCRIPT = `
//VERSION=3
function setup() {
  return {
    input: ["B02", "B04", "B08", "B11", "B12", "SCL", "dataMask"],
    output: [
      { id: "observability", bands: 3, sampleType: "FLOAT32" },
      { id: "spectral", bands: 2, sampleType: "FLOAT32" }
    ]
  };
}
function evaluatePixel(sample) {
  const sourceDataMask = sample.dataMask > 0 ? 1 : 0;
  const cloudMask = sample.SCL === 0 || sample.SCL === 1 || sample.SCL === 3 || (sample.SCL >= 7 && sample.SCL <= 11) ? 1 : 0;
  const validAnalysisMask = sourceDataMask === 1 && cloudMask === 0 ? 1 : 0;
  const nbrDenominator = sample.B08 + sample.B12;
  const nbr = nbrDenominator === 0 ? 0 : (sample.B08 - sample.B12) / nbrDenominator;
  const bsiDenominator = sample.B08 + sample.B04;
  const bsi = bsiDenominator === 0 ? 0 : ((sample.B11 + sample.B04) - (sample.B08 + sample.B02)) / bsiDenominator;
  return { observability: [sourceDataMask, cloudMask, validAnalysisMask], spectral: [validAnalysisMask ? nbr : NaN, validAnalysisMask ? bsi : NaN] };
}
`;
function bandStats(output, band) {
    return output?.bands?.[`B${band}`]?.stats ?? output?.bands?.B0?.stats;
}
function metricValue(output, band) {
    const stats = bandStats(output, band);
    return stats && typeof stats.mean === "number" ? stats.mean : undefined;
}
function countValue(output, band) {
    const stats = bandStats(output, band);
    const count = stats?.sampleCount ?? stats?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : 0;
}
export async function getSentinel2VerificationStats(params) {
    const body = {
        input: {
            bounds: { bbox: params.bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
            data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: params.fromTime, to: params.toTime }, maxCloudCoverage: Math.max(0, Math.min(100, params.maxCloudCoverage)), mosaickingOrder: "mostRecent" } }]
        },
        aggregation: { timeRange: { from: params.fromTime, to: params.toTime }, aggregationInterval: { of: "P1D" }, evalscript: OBSERVABILITY_EVALSCRIPT, resx: 20, resy: 20 }
    };
    const { data } = await requestSentinelHub("/api/v1/statistics", { method: "POST", body: JSON.stringify(body) });
    if (!Array.isArray(data?.data))
        throw new Error("Sentinel Hub statistics response was malformed.");
    const slice = data.data[0];
    if (!slice?.outputs) {
        return { metrics: [], geometryPixelCount: 0, sourceValidPixelCount: 0, analysisValidPixelCount: 0, localCloudPixelCount: 0, noUsablePixels: true, acquisitionTimes: [] };
    }
    const observability = slice.outputs.observability;
    const spectral = slice.outputs.spectral;
    const geometryPixelCount = countValue(observability, 0);
    const sourceValidPixelCount = countValue(observability, 0) * (metricValue(observability, 0) ?? 0);
    const localCloudPixelCount = countValue(observability, 1) * (metricValue(observability, 1) ?? 0);
    const analysisValidPixelCount = countValue(observability, 2) * (metricValue(observability, 2) ?? 0);
    const sourcePercent = geometryPixelCount > 0 ? sourceValidPixelCount / geometryPixelCount * 100 : undefined;
    const cloudPercent = sourceValidPixelCount > 0 ? localCloudPixelCount / sourceValidPixelCount * 100 : undefined;
    const validPercent = geometryPixelCount > 0 ? analysisValidPixelCount / geometryPixelCount * 100 : undefined;
    const metrics = [
        { name: "geometry_pixel_count", value: geometryPixelCount, unit: "pixels" },
        { name: "source_valid_pixel_count", value: sourceValidPixelCount, unit: "pixels" },
        { name: "analysis_valid_pixel_count", value: analysisValidPixelCount, unit: "pixels" },
        { name: "local_cloud_pixel_count", value: localCloudPixelCount, unit: "pixels" },
        ...(cloudPercent === undefined ? [] : [{ name: "local_cloud_percent", value: cloudPercent, unit: "%" }]),
        ...(validPercent === undefined ? [] : [{ name: "valid_analysis_pixel_percent", value: validPercent, unit: "%" }]),
        ...(metricValue(spectral, 0) === undefined ? [] : [{ name: "nbr", value: metricValue(spectral, 0), unit: "ratio", interpretation: "NBR over analysis-valid pixels" }]),
        ...(metricValue(spectral, 1) === undefined ? [] : [{ name: "bsi", value: metricValue(spectral, 1), unit: "ratio", interpretation: "BSI over analysis-valid pixels" }])
    ];
    return {
        metrics,
        geometryPixelCount,
        sourceValidPixelCount,
        analysisValidPixelCount,
        localCloudPixelCount,
        localCloudPercent: cloudPercent,
        validAnalysisPixelPercent: validPercent,
        noUsablePixels: analysisValidPixelCount <= 0,
        acquisitionTimes: Array.isArray(slice?.interval?.from) ? slice.interval.from : []
    };
}
