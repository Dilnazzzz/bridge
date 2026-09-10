import Tutor from './tutor';
import { getConstructions, getLanguage } from '@/lib/constructions';

export default function Page() {
  const constructions = getConstructions().map((c) => ({ id: c.id, title: c.title }));
  return <Tutor constructions={constructions} language={getLanguage()} />;
}
