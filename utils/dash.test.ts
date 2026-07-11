import { describe, expect, it } from 'vitest';
import { parseDashManifest } from './dash';

const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="1" bandwidth="1200000" width="640" height="360" codecs="avc1.42c01e">
    <BaseURL>video360.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
   <Representation id="2" bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f">
    <BaseURL>video720.mp4</BaseURL>
    <SegmentBase indexRange="0-100"/>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

describe('parseDashManifest', () => {
  const r = parseDashManifest(MPD, 'https://ex.com/dir/stream.mpd');

  it('2 representation, sắp xếp giảm dần theo height', () => {
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0]!.height).toBe(720);
    expect(r.variants[1]!.height).toBe(360);
  });

  it('resolvedUri tuyệt đối theo baseUrl của mpd', () => {
    expect(r.variants[0]!.uri).toBe('https://ex.com/dir/video720.mp4');
  });

  it('isMaster true khi có nhiều hơn 1 variant', () => {
    expect(r.isMaster).toBe(true);
  });
});
