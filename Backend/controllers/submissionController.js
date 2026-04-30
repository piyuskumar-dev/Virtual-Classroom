const Submission = require('../models/submissionModel');
const Assignment = require('../models/assignmentModel');
const { Classroom } = require('../models/classroomModel');
const { extractText } = require("../utils/extractText");
const { evaluateSolution } = require('../services/aiEvaluator');
const { uploadToImageKit, deleteFromImageKit, isImageKitConfigured } = require('../config/imagekit');

const FILE_DOWNLOAD_TIMEOUT_MS = 20000;

const getSubmissionFileUrl = (submissionLike) => {
    const candidates = [submissionLike?.fileUrl, submissionLike?.solutionFileURL];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return null;
};

const syncSubmissionFileUrlFields = (submissionLike, fileUrl) => {
    submissionLike.fileUrl = fileUrl;
    submissionLike.solutionFileURL = fileUrl;
};

const downloadSubmissionFileBuffer = async (fileUrl, contextLabel) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FILE_DOWNLOAD_TIMEOUT_MS);

    try {
        console.log(`[${contextLabel}] Downloading file`, { fileUrl });
        const response = await fetch(fileUrl, { signal: controller.signal });
        if (!response.ok) {
            const downloadError = new Error(`Failed to download submission file (status ${response.status})`);
            downloadError.statusCode = response.status;
            throw downloadError;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer || buffer.length === 0) {
            const emptyError = new Error('Downloaded submission file is empty.');
            emptyError.statusCode = 422;
            throw emptyError;
        }
        console.log(`[${contextLabel}] Download success`, { size: buffer.length });
        return buffer;
    } finally {
        clearTimeout(timeoutId);
    }
};

const mapDownloadErrorToResponse = (downloadError) => {
    if (downloadError?.name === 'AbortError') {
        return { statusCode: 504, message: 'Timed out while downloading submission file.' };
    }
    if (downloadError?.statusCode === 404) {
        return { statusCode: 404, message: 'Student submission file not found on file storage.' };
    }
    if (typeof downloadError?.statusCode === 'number' && downloadError.statusCode >= 400 && downloadError.statusCode < 500) {
        return { statusCode: downloadError.statusCode, message: downloadError.message || 'Submission file download failed.' };
    }
    return { statusCode: 502, message: 'Unable to download submission file from file storage.' };
};

const submitAssignment = async (req, res) => {
    try {
        const { assignmentId } = req.body;
        const file = req.file;

        console.log('[submission/submit] Request received', {
            userId: req.user?.id || null,
            assignmentId: assignmentId || null,
            hasFile: !!file,
            bodyKeys: Object.keys(req.body || {}),
        });

        if (!assignmentId) {
            return res.status(400).json({ message: 'Assignment ID is required.' });
        }
        if (!file) {
            return res.status(400).json({ message: 'Submission file is required (form-data field: "file").' });
        }
        if (file.buffer && file.buffer.length === 0) {
            return res.status(400).json({ message: 'Uploaded file is empty.' });
        }

        const assignment = await Assignment.findById(assignmentId);
        if (!assignment) {
            return res.status(404).json({ message: 'Assignment not found.' });
        }

        const classroom = await Classroom.findById(assignment.classroom);
        if (!classroom) {
            return res.status(404).json({ message: 'Classroom not found.' });
        }

        const userId = req.user.id;
        const isStudent = classroom.students.some((studentId) => studentId.toString() === userId);
        if (!isStudent) {
            return res.status(403).json({ message: 'Only classroom students can submit work.' });
        }

        if (!isImageKitConfigured()) {
            return res.status(500).json({
                message: 'ImageKit not configured. Please set IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, and IMAGEKIT_URL_ENDPOINT.',
            });
        }

        console.log('[submission/submit] Uploading file to ImageKit', {
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
        });
        const uploadResult = await uploadToImageKit(file, 'submissions');
        const fileUrl = getSubmissionFileUrl({
            fileUrl: uploadResult.url,
            solutionFileURL: uploadResult.url,
        });

        if (!fileUrl || !uploadResult.fileId) {
            return res.status(500).json({ message: 'ImageKit upload did not return a valid file URL.' });
        }

        let submission = await Submission.findOne({ assignment: assignmentId, student: req.user.id });
        if (submission?.imagekitFileId) {
            try {
                await deleteFromImageKit(submission.imagekitFileId);
            } catch (deleteError) {
                console.error('[submission/submit] Failed to delete previous ImageKit file:', deleteError);
            }
        }

        if (!submission) {
            submission = new Submission({
                assignment: assignmentId,
                student: req.user.id,
                fileUrl,
                solutionFileURL: fileUrl,
                imagekitFileId: uploadResult.fileId,
                isEvaluated: false,
                isPublished: false,
            });
        } else {
            syncSubmissionFileUrlFields(submission, fileUrl);
            submission.imagekitFileId = uploadResult.fileId;
            submission.marks = 0;
            submission.feedback = [];
            submission.evaluated = false;
            submission.aiScore = null;
            submission.aiFeedback = null;
            submission.isEvaluated = false;
            submission.isPublished = false;
        }

        await submission.save();

        console.log('[submission/submit] Response sent', {
            submissionId: submission._id,
            fileId: submission.imagekitFileId,
            fileUrl,
        });
        return res.status(201).json({ message: 'Assignment submitted successfully', submission });
    } catch (error) {
        console.error('[submission/submit] Error:', error);
        return res.status(500).json({ message: error?.message || 'Failed to submit assignment.' });
    }
};

const getAssignmentSubmissions = async (req, res) => {
    try {
        const { assignmentId } = req.params;
        console.log('[submission/assignment] Fetch request', {
            assignmentId,
            userId: req.user?.id || null,
        });

        const assignment = await Assignment.findById(assignmentId);
        if (!assignment) {
            return res.status(404).json({ message: 'Assignment not found.' });
        }

        if (assignment.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Not allowed to view these submissions.' });
        }

        const submissions = await Submission.find({ assignment: assignmentId }).populate('student', 'name email');
        const formattedSubmissions = [];
        const updates = [];

        for (const submission of submissions) {
            const submissionObj = submission.toObject();
            const fileUrl = getSubmissionFileUrl(submissionObj);
            const needsSync = !!fileUrl && (
                submissionObj.fileUrl !== fileUrl ||
                submissionObj.solutionFileURL !== fileUrl
            );

            if (needsSync) {
                updates.push({
                    updateOne: {
                        filter: { _id: submissionObj._id },
                        update: { $set: { fileUrl, solutionFileURL: fileUrl } },
                    },
                });
            }

            submissionObj.fileUrl = fileUrl;
            submissionObj.solutionFileURL = fileUrl;

            console.log('[submission/assignment] Submission URL', {
                submissionId: submissionObj._id,
                fileUrl: fileUrl || null,
            });
            formattedSubmissions.push(submissionObj);
        }

        if (updates.length > 0) {
            try {
                await Submission.bulkWrite(updates);
            } catch (syncError) {
                console.error('[submission/assignment] URL sync failed:', syncError);
            }
        }

        console.log('[submission/assignment] Response sent', {
            assignmentId,
            count: formattedSubmissions.length,
        });
        return res.json({ submissions: formattedSubmissions });
    } catch (error) {
        console.error('[submission/assignment] Error:', error);
        return res.status(500).json({ message: 'Failed to fetch submissions.' });
    }
};

const evaluateSubmission = async (req, res) => {
    try {
        const { submissionId } = req.params;
        const { marks, feedback } = req.body;

        const submission = await Submission.findById(submissionId);
        if (!submission) return res.status(404).json({ message: 'Submission not found' });

        const assignment = await Assignment.findById(submission.assignment);
        if (!assignment) return res.status(404).json({ message: 'Assignment not found' });
        if (assignment.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Not allowed to evaluate this submission.' });
        }

        if (marks !== undefined) submission.marks = marks;
        if (feedback !== undefined) submission.feedback = feedback;
        submission.evaluated = true;
        submission.isEvaluated = true;

        await submission.save();
        return res.json({ message: 'Evaluation saved successfully', submission });
    } catch (error) {
        console.error('[submission/evaluate] Error:', error);
        return res.status(500).json({ message: 'Failed to save evaluation.' });
    }
};

const evaluateSubmissionWithAI = async (req, res) => {
    try {
        const { submissionId } = req.params;
        console.log('[submission/evaluate-ai] Request received', {
            submissionId,
            userId: req.user?.id || null,
        });

        const submission = await Submission.findById(submissionId);
        if (!submission) return res.status(404).json({ message: 'Submission not found' });

        const assignment = await Assignment.findById(submission.assignment);
        if (!assignment) return res.status(404).json({ message: 'Assignment not found' });
        if (assignment.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Not allowed to evaluate this submission.' });
        }

        const fileUrl = getSubmissionFileUrl(submission);
        if (!fileUrl) {
            return res.status(422).json({ message: 'Submission file URL is missing.' });
        }
        if (submission.fileUrl !== fileUrl || submission.solutionFileURL !== fileUrl) {
            syncSubmissionFileUrlFields(submission, fileUrl);
        }

        let studentBuffer;
        try {
            studentBuffer = await downloadSubmissionFileBuffer(fileUrl, 'submission/evaluate-ai');
        } catch (downloadError) {
            console.error('[submission/evaluate-ai] File download error:', downloadError);
            const mapped = mapDownloadErrorToResponse(downloadError);
            return res.status(mapped.statusCode).json({ message: mapped.message });
        }

        let studentText = "";
        try {
            studentText = await extractText(studentBuffer, { filename: fileUrl });
        } catch (e) {
            console.error("Text extraction failed, falling back to sending file buffer:", e);
        }
        
        let mimeType = "application/pdf";
        if (fileUrl.toLowerCase().endsWith(".png")) mimeType = "image/png";
        else if (fileUrl.toLowerCase().endsWith(".jpg") || fileUrl.toLowerCase().endsWith(".jpeg")) mimeType = "image/jpeg";
        else if (fileUrl.toLowerCase().endsWith(".txt")) mimeType = "text/plain";

        const ai = await evaluateSolution({
            assignmentTitle: assignment?.title,
            assignmentPrompt: assignment?.description,
            studentAnswerText: studentText,
            studentBuffer: studentBuffer,
            mimeType: mimeType
        });

        submission.aiScore = ai.score;
        submission.aiFeedback = ai.feedback;
        submission.isEvaluated = true;
        submission.evaluated = true;
        submission.evaluating = false;
        submission.marks = ai.score;
        submission.feedback = String(ai.feedback || '').split('\n').filter(Boolean);
        
        try {
            await submission.save();
        } catch (saveError) {
            if (saveError.name === 'VersionError') {
                console.warn('[submission/evaluate-ai] VersionError ignored, submission evaluated by concurrent request.');
                return res.json({ message: 'AI evaluation completed concurrently', submission });
            }
            throw saveError;
        }

        console.log('[submission/evaluate-ai] Response sent', {
            submissionId: submission._id,
            score: submission.aiScore,
        });
        return res.json({ message: 'AI evaluation completed', submission });
    } catch (error) {
        console.error('[submission/evaluate-ai] Error:', error);
        return res.status(500).json({ message: 'Failed to evaluate submission with AI.' });
    }
};

const getSubmissionQueue = async (req, res) => {
    try {
        const { classroomId } = req.query;
        const page = Math.max(parseInt(req.query.page || '1', 10), 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 100);

        if (!classroomId) return res.status(400).json({ message: 'classroomId is required' });

        const classroom = await Classroom.findById(classroomId);
        if (!classroom) return res.status(404).json({ message: 'Classroom not found' });
        if (classroom.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Only the classroom teacher can view the submission queue.' });
        }

        const assignments = await Assignment.find({ classroom: classroomId }).select('_id');
        const assignmentIds = assignments.map((assignment) => assignment._id);

        const query = { assignment: { $in: assignmentIds } };
        const total = await Submission.countDocuments(query);
        const submissions = await Submission.find(query)
            .sort({ createdAt: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('student', 'name email')
            .populate('assignment', 'title');

        return res.json({
            page,
            limit,
            total,
            submissions,
        });
    } catch (error) {
        console.error('[submission/queue] Error:', error);
        return res.status(500).json({ message: 'Failed to fetch submission queue.' });
    }
};

const evaluateNextInQueue = async (req, res) => {
    try {
        const { classroomId } = req.body;
        console.log('[submission/evaluate-next] Request received', {
            classroomId: classroomId || null,
            userId: req.user?.id || null,
        });

        if (!classroomId) return res.status(400).json({ message: 'classroomId is required' });

        const classroom = await Classroom.findById(classroomId);
        if (!classroom) return res.status(404).json({ message: 'Classroom not found' });
        if (classroom.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Only the classroom teacher can run AI evaluation.' });
        }

        const assignments = await Assignment.find({ classroom: classroomId }).select('_id title description');
        const assignmentIds = assignments.map((assignment) => assignment._id);

        // Use findOneAndUpdate to atomically set an evaluating flag
        // to prevent race conditions with other evaluate calls.
        const submission = await Submission.findOneAndUpdate({
            assignment: { $in: assignmentIds },
            isEvaluated: false,
            $or: [{ evaluating: { $exists: false } }, { evaluating: false }]
        }, { $set: { evaluating: true } }, { new: true, sort: { createdAt: 1 } });

        if (!submission) {
            return res.json({ message: 'No pending submissions to evaluate', submission: null });
        }

        const assignment = assignments.find((item) => item._id.toString() === submission.assignment.toString())
            || await Assignment.findById(submission.assignment);
        if (!assignment) {
            return res.status(404).json({ message: 'Assignment not found' });
        }

        const fileUrl = getSubmissionFileUrl(submission);
        if (!fileUrl) {
            return res.status(422).json({ message: 'Submission file URL is missing.' });
        }
        if (submission.fileUrl !== fileUrl || submission.solutionFileURL !== fileUrl) {
            syncSubmissionFileUrlFields(submission, fileUrl);
        }

        let studentBuffer;
        try {
            studentBuffer = await downloadSubmissionFileBuffer(fileUrl, 'submission/evaluate-next');
        } catch (downloadError) {
            console.error('[submission/evaluate-next] File download error:', downloadError);
            const mapped = mapDownloadErrorToResponse(downloadError);
            return res.status(mapped.statusCode).json({ message: mapped.message });
        }

        let studentText = "";
        try {
            studentText = await extractText(studentBuffer, { filename: fileUrl });
        } catch (e) {
            console.error("Text extraction failed, falling back to sending file buffer:", e);
        }

        let mimeType = "application/pdf";
        if (fileUrl.toLowerCase().endsWith(".png")) mimeType = "image/png";
        else if (fileUrl.toLowerCase().endsWith(".jpg") || fileUrl.toLowerCase().endsWith(".jpeg")) mimeType = "image/jpeg";
        else if (fileUrl.toLowerCase().endsWith(".txt")) mimeType = "text/plain";

        const ai = await evaluateSolution({
            assignmentTitle: assignment?.title,
            assignmentPrompt: assignment?.description,
            studentAnswerText: studentText,
            studentBuffer: studentBuffer,
            mimeType: mimeType
        });

        submission.aiScore = ai.score;
        submission.aiFeedback = ai.feedback;
        submission.isEvaluated = true;
        submission.evaluated = true;
        submission.evaluating = false;
        submission.marks = ai.score;
        submission.feedback = String(ai.feedback || '').split('\n').filter(Boolean);
        
        try {
            await submission.save();
        } catch (saveError) {
            if (saveError.name === 'VersionError') {
                console.warn('[submission/evaluate-next] VersionError ignored, submission evaluated by concurrent request.');
                return res.json({ message: 'AI evaluation completed concurrently', submission });
            }
            throw saveError;
        }

        console.log('[submission/evaluate-next] Response sent', {
            submissionId: submission._id,
            score: submission.aiScore,
        });
        return res.json({ message: 'AI evaluation completed', submission });
    } catch (error) {
        console.error('[submission/evaluate-next] Error:', error);
        return res.status(500).json({ message: 'Failed to evaluate submission with AI.' });
    }
};

const publishResults = async (req, res) => {
    try {
        const { classroomId } = req.body;
        if (!classroomId) return res.status(400).json({ message: 'classroomId is required' });

        const classroom = await Classroom.findById(classroomId);
        if (!classroom) return res.status(404).json({ message: 'Classroom not found' });
        if (classroom.teacher.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Only the classroom teacher can publish results.' });
        }

        const assignments = await Assignment.find({ classroom: classroomId }).select('_id');
        const assignmentIds = assignments.map((assignment) => assignment._id);
        const result = await Submission.updateMany(
            { assignment: { $in: assignmentIds }, isEvaluated: true, isPublished: false },
            { $set: { isPublished: true } }
        );

        return res.json({ message: 'Results published', modifiedCount: result.modifiedCount });
    } catch (error) {
        console.error('[submission/publish] Error:', error);
        return res.status(500).json({ message: 'Failed to publish results.' });
    }
};

const getMySubmission = async (req, res) => {
    try {
        const { assignmentId } = req.query;
        console.log('[submission/my] Fetch request', {
            assignmentId: assignmentId || null,
            userId: req.user?.id || null,
        });

        if (!assignmentId) return res.status(400).json({ message: 'assignmentId is required' });

        const submission = await Submission.findOne({ assignment: assignmentId, student: req.user.id });
        if (!submission) return res.status(404).json({ message: 'Submission not found' });

        const fileUrl = getSubmissionFileUrl(submission);
        const needsSync = !!fileUrl && (
            submission.fileUrl !== fileUrl ||
            submission.solutionFileURL !== fileUrl
        );
        if (needsSync) {
            syncSubmissionFileUrlFields(submission, fileUrl);
            await submission.save();
        }

        if (!submission.isPublished) {
            return res.json({
                submission: {
                    _id: submission._id,
                    assignment: submission.assignment,
                    student: submission.student,
                    fileUrl,
                    solutionFileURL: fileUrl,
                    createdAt: submission.createdAt,
                    isEvaluated: submission.isEvaluated,
                    isPublished: submission.isPublished,
                },
            });
        }

        const submissionObj = submission.toObject();
        submissionObj.fileUrl = fileUrl;
        submissionObj.solutionFileURL = fileUrl;
        return res.json({ submission: submissionObj });
    } catch (error) {
        console.error('[submission/my] Error:', error);
        return res.status(500).json({ message: 'Failed to fetch submission.' });
    }
};

module.exports = {
    submitAssignment,
    getAssignmentSubmissions,
    evaluateSubmission,
    evaluateSubmissionWithAI,
    getSubmissionQueue,
    evaluateNextInQueue,
    publishResults,
    getMySubmission,
};
