import { Composition } from "remotion";
import { Pitch } from "./Pitch";
import { FPS, H, W } from "./theme";
import { TOTAL } from "./timing";

export function Root() {
  return <Composition id="Pitch" component={Pitch} durationInFrames={Math.ceil(TOTAL * FPS)} fps={FPS} width={W} height={H} />;
}
