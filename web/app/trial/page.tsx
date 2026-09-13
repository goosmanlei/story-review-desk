import {redirect} from 'next/navigation';

// Retained candidates are ordinary versioned materials in the shared workspace.
export default function CandidatesPage(){redirect('/?view=materials');}
