const mongoose = require("mongoose");
const express = require("express");
const router = express.Router();
const upload = require("../middleware/upload");
const bodyParser = require("body-parser");
const url = "mongodb://127.0.0.1:27017/Maqraaty";
const {
  StudentSchema,
  PaymentSchema,
  AttendanceSchema,
  ActiveOrInActiveSchema,
} = require("../models/studentsModel");
const objectId = require("mongodb").ObjectId;
let schema = mongoose.Schema;
const AutoIncrementFactory = require("mongoose-sequence");
const xlsx2mongo = require("xlsx-mongo");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
// const studentSchema = new schema({
//   name: String,
//   phone_1: String,
//   phone_2: String,
//   landline: String,
//   address: String,
//   notes: String,
//   image: String,
// });

const Payment = mongoose.model("payment", PaymentSchema);
const Attendance = mongoose.model("attendance", AttendanceSchema);
const Student = mongoose.model("student", StudentSchema);
const ActiveOrInactive = mongoose.model(
  "activeOrInactive",
  ActiveOrInActiveSchema,
);
function generateSixDigits() {
  return Math.floor(100000 + Math.random() * 900000);
}
let today = new Date(); // Get today's date
let currentYear = today.getFullYear();
let currentMonth = today.getMonth() + 1; // Adding 1 since months are 0-based
let startDate = new Date(currentYear, currentMonth - 1, 0)
  .toLocaleDateString("en-CA")
  ?.split("T")[0];
let endDate = new Date(currentYear, currentMonth, 1)
  .toLocaleDateString("en-CA")
  ?.split("T")[0];

console.log(startDate, endDate);
// mongoose.connect(url, { useBigInt64: false }).then((clientdb) => {
// console.log(clientdb);
//Read students data

router.get("/students", async (req, res) => {
  // const {page , limit } = req.query;

  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { status, code, name, phone } = req.query;
  const matchData = () => {
    const match = {};

    if (code) {
      match.code = Number(code);
    }

    if (name) {
      match.$expr = {
        $regexMatch: {
          input: "$name",
          regex: name,
          options: "i",
        },
      };
    }

    if (phone) {
      match.$or = [
        { phone_1: { $regex: phone, $options: "i" } },
        { phone_2: { $regex: phone, $options: "i" } },
        { phone_3: { $regex: phone, $options: "i" } },
      ];
    }

    return match;
  };

  const matchActiveOrInactive = () => {
    if (startDate) {
      const start = new Date(startDate);
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);

      // Check if the start date is in current month
      if (start.getMonth() + 1 === today.getMonth() + 1) {
        // For current month, just check active_status in Student table
        return { active_status: "active" };
      } else {
        // For previous/old months, check both Student table and activeOrInactiveDetails
        return {
          $and: [
            { active_status: "active" }, // Must be active in Student table
            {
              $or: [
                // Either no activeOrInactiveDetails exist for this month
                { activeOrInactiveDetails: { $size: 0 } },
                // Or activeOrInactiveDetails exist but none have in_active status
                {
                  activeOrInactiveDetails: {
                    $not: {
                      $elemMatch: {
                        activeStatus: "in_active",
                      },
                    },
                  },
                },
              ],
            },
          ],
        };
      }
    } else {
      return {};
    }
  };
  await Student.aggregate([
    // {
    //   $lookup: {
    //     from: ActiveOrInactive.collection.name,
    //     localField: "_id",
    //     foreignField: "student",
    //     as: "activeOrInactiveDetails",
    //   },
    // },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$_id" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        ...matchActiveOrInactive(),
      },
    },
    // {
    //   $unwind: {
    //     path: "$activeOrInactiveDetails", // Unwind the studentDetails array
    //     preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
    //   },
    // },
    // {
    //   $addFields: {
    //     activeOrInactiveDetails: "$activeOrInactiveDetails", // Move studentDetails back to top level
    //   },
    // },
    {
      $match: {
        ...matchData(),
        // active_status: "active",
      },
    },
    {
      $sort: {
        // name: 1,
        code: 1,
      },
    },
    {
      $facet: {
        metaData: [
          {
            $count: "total",
          },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        totalAmount: [{ $group: { _id: null, total: { $sum: "$amount" } } }],
        data: [
          {
            $skip: Number((page - 1) * limit),
          },
          {
            $limit: Number(limit),
          },
        ],
      },
    },
  ])
    .exec()
    .then((data) => {
      console.log("students data =====>", data);
      let result = data[0];
      // result.data = result.data.map(d=>{return {...d,activeOrInactiveDetails:d.activeOrInactiveDetails[0]?d.activeOrInactiveDetails[0]:{}}});
      result.metaData = {
        ...data[0].metaData[0],
        count: data[0]?.data?.length,
      };
      res.status(200).send(result);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

router.get("/all-students", async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { status, code, name, phone } = req.query;

  const matchData = () => {
    const match = {};

    if (code) {
      match.code = Number(code);
    }

    if (status) {
      match.active_status = status;
    }

    if (name) {
      match.$expr = {
        $regexMatch: { input: "$name", regex: name, options: "i" },
      };
    }

    if (phone) {
      match.$or = [
        { phone_1: { $regex: phone, $options: "i" } },
        { phone_2: { $regex: phone, $options: "i" } },
        { phone_3: { $regex: phone, $options: "i" } },
      ];
    }

    return match;
  };

  await Student.aggregate([
    {
      $lookup: {
        from: ActiveOrInactive.collection.name,
        let: { studentId: "$_id" },
        pipeline: [
          {
            $match: {
              $and: [
                { $expr: { $eq: ["$student", "$$studentId"] } },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails",
      },
    },
    {
      $match: { ...matchData() },
    },
    // ── Filter empty/null values then convert relative string IDs → ObjectIds ──
    {
      $addFields: {
        relative: {
          $map: {
            input: {
              $filter: {
                input: "$relative",
                as: "r",
                cond: {
                  $and: [{ $ne: ["$$r", ""] }, { $ne: ["$$r", null] }],
                },
              },
            },
            as: "r",
            in: { $toObjectId: "$$r" },
          },
        },
      },
    },
    // ── Lookup relative students and return only _id and name ──
    {
      $lookup: {
        from: Student.collection.name,
        let: { relativeIds: "$relative" },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$_id", "$$relativeIds"] },
            },
          },
          { $project: { _id: 1, name: 1 } },
        ],
        as: "relative",
      },
    },
    {
      $sort: { code: 1 },
    },
    {
      $facet: {
        metaData: [
          { $count: "total" },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        totalAmount: [{ $group: { _id: null, total: { $sum: "$amount" } } }],
        data: [
          { $skip: Number((page - 1) * limit) },
          { $limit: Number(limit) },
        ],
      },
    },
  ])
    .exec()
    .then((data) => {
      console.log("students data =====>", data);
      let result = data[0];
      result.metaData = {
        ...data[0].metaData[0],
        count: data[0]?.data?.length,
      };
      res.status(200).send(result);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

// student next code
router.get("/student_code", async (req, res) => {
  const students = await Student.find().exec();
  res.status(200).json({ code: students.length + 1 });
});
//get one user
router.get("/one_student", async (req, res) => {
  const { Id } = req.query;
  let user = await Student.findById(new objectId(Id)).exec();
  console.log("res ====>", res);
  res.status(200).send(user);
});
//get all names of students
router.get("/students_name", async (req, res) => {
  const { active_status } = req.query;

  const matchActiveOrInactive = () => {
    console.log(new Date(startDate).getMonth() + 2);
    return active_status ? { active_status: active_status } : {};
  };
  let user = await Student.aggregate([
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$_id" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        ...matchActiveOrInactive(),
      },
    },
    {
      $sort: {
        name: 1,
      },
    },
  ])
    .exec()
    .then((data) => data);
  // console.log(user);
  // let data = user.map((data) => {
  //   return { _id: data._id, name: data.name };
  // });
  // console.log("user ====>", user);
  res.status(200).send(user);
});

//Upload image
router.post("/upload-image", upload.single("file"), (req, res) => {
  console.log(req.file);
  if (req.file.size > 1024 * 1024 * 50) {
    res.status(413).json({
      message: "file is too large please upload file smaller than 50mb",
    });
  } else {
    res.send(req.file);
  }
});

//Add new student Data
router.post(
  "/add_student",
  bodyParser.json({ extended: true }),
  async (req, res) => {
    console.log(req.body);
    //   Student.createIndexes({ code: 1 }, (err) => {
    //     if (err) console.error(err);
    //   });
    // Student.listIndexes((err, indexes) => {
    //   if (err) console.error(err);
    //   console.log(indexes);
    // });
    // studentSchema.pre('save', function(next) {
    //   var doc = this;
    //   counter.findByIdAndUpdate({_id:"studentId"}, {$inc: { seq: 1} }, function(error, counter)   {
    //       if(error)
    //           return next(error);
    //       doc.code = counter.seq;
    //       next();
    //   });
    // });
    const data = await Student.find();
    if (req.body) {
      await Student.create({
        active_status: "active",
        code: data.length + 1,
        ...req.body,
      }).then((data) => {
        console.log("data", data);
        // clientdb.disconnect()
        res.status(200).json({ message: "student added success", data });
      });
    } else {
      res.status(400).json({ message: "no data found" });
    }
  },
);

//Update one student Data
router.put(
  "/update_student",
  bodyParser.json({ extended: true }),
  (req, res) => {
    console.log(req.body);
    console.log(req.query?.id);
    console.log(req.params);

    if (req.body) {
      Student.findByIdAndUpdate(new objectId(req.query?.id), req.body).then(
        (value) => {
          console.log(value);
          //  clientdb.disconnect()
          res.status(200).json({ message: "student updated successfuly" });
        },
      );
    } else {
      res.status(400).json({ message: "no data found" });
    }
  },
);
//search of data
router.get("/search_student", async (req, res) => {
  console.log(req.query?.code);
  console.log(req.query?.name);
  console.log(req.query?.phone);
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  console.log(
    Object.keys(req.query)
      .filter((value) => value !== undefined)
      .map((d) => {
        {
          return d;
        }
      }),
  );
  const filter = Object.keys(req.query)
    .filter((value) => value !== undefined)
    .map((d) => {
      if (d == "name") {
        {
          return { name: { $in: new RegExp(req.query[d], "i") } };
        }
      } else if (d == "phone") {
        {
          return {
            $or: [
              { phone_1: { $in: new RegExp(req.query[d], "i") } },
              { phone_2: { $in: new RegExp(req.query[d], "i") } },
              { phone_3: { $in: new RegExp(req.query[d], "i") } },
            ],
          };
        }
      } else if (d == "code") {
        {
          return { code: Number(req.query[d]) };
        }
      } else if (d == "status") {
        {
          return { active_status: req.query[d] };
        }
      } else {
      }
    })
    .concat([]);
  console.log(filter);
  let filterOp;
  if (filter.filter((d) => d !== undefined).length > 0) {
    filterOp = { $and: filter.filter((d) => d !== undefined) };
  } else {
    filterOp = {};
  }
  console.log("filterOp ===", filterOp);
  const queryName = new RegExp(req.query?.name, "i");
  const queryPhone = new RegExp(req.query?.phone, "i");
  // const querCode = new objectId(req.query?.code);
  const totalDoc = await Student.find(filterOp);
  await Student.find(filterOp)
    .skip((page - 1) * limit)
    .limit(limit)
    .sort({ code: 1 })
    .then((value) => {
      console.log("data ===", value);
      //  clientdb.disconnect()
      res.status(200).json({
        metaData: {
          total: totalDoc?.length,
          pageNumber: page,
          totalPages: Math.ceil(totalDoc?.length / limit),
          count: value?.length,
        },
        data: value,
      });
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

//change status of one student Data
router.delete("/delete_student", async (req, res) => {
  console.log(req.body);
  console.log(req.query?.id);
  console.log(req.params);
  if (req.query?.id) {
    try {
      await Student.findByIdAndDelete(new objectId(req.query?.id))
        .then(async (value) => {
          await Attendance.deleteMany({
            student: new objectId(req.query?.id),
          }).then(async (d) => {
            await Payment.deleteMany({
              student: new objectId(req.query?.id),
            }).then((response) => {
              res.status(200).json({ message: "student deleted successfuly" });
            });
          });
        })
        .catch((error) => {
          res.status(500).json({ message: error.message });
        });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  } else {
    res.status(400).json({ message: "no data found" });
  }
});

//change status of one student Data
router.patch("/active_student", async (req, res) => {
  console.log(req.body);
  console.log(req.query?.id);
  console.log(req.params);
  if (req.query?.id) {
    await Student.findByIdAndUpdate(new objectId(req.query?.id), {
      active_status: req.body.status,
    }).then(async (value) => {
      console.log(value);
      if (req.query.status == "in_active") {
        res.status(200).json({ message: "student deleted successfuly" });
      } else {
        res.status(200).json({ message: "student actived successfuly" });
      }
    });
  } else {
    res.status(400).json({ message: "no data found" });
  }
});

//Add new payment
router.post(
  "/add_payment",
  bodyParser.json({ extended: true }),
  async (req, res) => {
    const amount = Number(req.body.amount);
    const date = req.body.date;
    const student = req.query.studentId;
    await Payment.create({ amount, date, student })
      .then((data) => {
        console.log(data);
        res.status(200).json({ message: "Payment added success", data });
      })
      .catch((err) => {
        res.status(400).json({ message: err.message });
      });
  },
);

//Get payments
router.get("/get_payments", async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { date } = req.query;
  const matchData = () => {
    if (date) {
      return {
        date: new Date(date),
      };
    } else {
      return {};
    }
  };

  const matchActiveOrInactivePay = () => {
    if (startDate) {
      console.log(new Date(startDate));
      const start = new Date(startDate);
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);
      console.log(start.getMonth());

      if (start.getMonth() + 1 == today.getMonth() + 1) {
        return { "studentDetails.active_status": "active" };
      } else
        return {
          activeOrInactiveDetails: {
            $exists: true,
            $not: {
              $elemMatch: {
                activeStatus: "in_active",
              },
            },
            $ne: [],
          },
        };
    } else {
      return {};
    }
  };
  // const matchData = Object.keys(req.query).filter(value => value !== undefined).map(d => {
  //   if (d == "date"){
  //     return {date:req.query[d]}
  //   }else {
  //     return {}
  //   }
  // })
  console.log(matchData(req.query.date));
  const totalAmounts = await Payment.aggregate([
    {
      $lookup: {
        from: "students", // Name of the other collection
        localField: "student", // Field from the attendance documents
        foreignField: "_id", // Field from the students documents
        as: "studentDetails", // Output array field
      },
    },
    {
      $unwind: {
        path: "$studentDetails", // Unwind the studentDetails array
        preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
      },
    },
    {
      $addFields: {
        studentDetails: "$studentDetails", // Move studentDetails back to top level
      },
    },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$student" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        activeOrInactiveDetails: {
          $not: {
            $elemMatch: {
              activeStatus: "in_active",
            },
          },
        },
        "studentDetails.active_status": "active",
      },
    },
    {
      $match: matchData(req.query.date),
    },
    {
      $group: {
        _id: null, // Group all documents together
        totalAmount: { $sum: "$amount" }, // Sum the 'amount' field
      },
    },
  ]);
  // Convert the totalAmounts to a map for easy lookup
  //  const totalAmountMap = new Map(totalAmounts.map(item => [item._id.toString(), item.totalAmount]));
  console.log(totalAmounts[0]?.totalAmount);
  await Payment.aggregate([
    {
      $lookup: {
        from: "students", // Name of the other collection
        localField: "student", // Field from the attendance documents
        foreignField: "_id", // Field from the students documents
        as: "studentDetails", // Output array field
      },
    },
    {
      $unwind: {
        path: "$studentDetails", // Unwind the studentDetails array
        preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
      },
    },
    {
      $addFields: {
        studentDetails: "$studentDetails", // Move studentDetails back to top level
      },
    },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$student" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        ...matchActiveOrInactivePay(),
      },
    },
    {
      $match: {
        ...matchData(),
      },
    },
    {
      $sort: {
        // "studentDetails.name": 1,
        updatedAt: 1,
        // "studentDetails.code": 1,
      },
    },
    {
      $facet: {
        metaData: [
          {
            $count: "total",
          },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        data: [
          {
            $skip: Number((page - 1) * limit),
          },
          {
            $limit: Number(limit),
          },
        ],
      },
    },
  ])
    .then((data) => {
      console.log(data);
      let result = data[0];
      result.metaData = {
        ...data[0].metaData[0],
        count: data[0]?.data?.length,
        totalAmount: totalAmounts[0]?.totalAmount,
      };
      res.status(200).send(result);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

//Get payment by id
router.get("/get_one_payment", async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { studentId } = req.query;
  const matchData = (e) => {
    if (e !== "" && e !== "undefined") {
      return {
        date: new Date(e),
      };
    } else {
      return {};
    }
  };
  // const matchData = Object.keys(req.query).filter(value => value !== undefined).map(d => {
  //   if (d == "date"){
  //     return {date:req.query[d]}
  //   }else {
  //     return {}
  //   }
  // })
  // console.log(matchData(req.query.date));
  const totalAmounts = await Payment.aggregate([
    {
      $match: { student: new objectId(studentId) },
    },
    {
      $group: {
        _id: null, // Group all documents together
        totalAmount: { $sum: "$amount" }, // Sum the 'amount' field
      },
    },
  ]);
  const studentDetails = await Student.aggregate([
    {
      $match: { _id: new objectId(studentId) },
    },
    // {
    //   $group: {
    //     _id: null, // Group all documents together
    //     totalAmount: { $sum: "$amount" } // Sum the 'amount' field
    //   }
    // }
  ]);
  // Convert the totalAmounts to a map for easy lookup
  //  const totalAmountMap = new Map(totalAmounts.map(item => [item._id.toString(), item.totalAmount]));
  console.log(totalAmounts[0]?.totalAmount);
  await Payment.aggregate([
    {
      $match: { student: new objectId(studentId) },
    },
    {
      $lookup: {
        from: "students", // Name of the other collection
        localField: "student", // Field from the attendance documents
        foreignField: "_id", // Field from the students documents
        as: "studentDetails", // Output array field
      },
    },
    {
      $unwind: {
        path: "$studentDetails", // Unwind the studentDetails array
        preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
      },
    },
    {
      $addFields: {
        studentDetails: "$studentDetails", // Move studentDetails back to top level
      },
    },
    {
      $facet: {
        metaData: [
          {
            $count: "total",
          },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        data: [
          {
            $skip: Number((page - 1) * limit),
          },
          {
            $limit: Number(limit),
          },
        ],
      },
    },
  ])
    .then((data) => {
      console.log(data);
      let result = data[0];
      result.metaData = {
        ...data[0].metaData[0],
        count: data[0]?.data?.length,
        totalAmount: totalAmounts[0]?.totalAmount,
        studentDetails: studentDetails[0],
      };
      res.status(200).send(result);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

//delete one Payment Data
router.delete("/delete_payment", (req, res) => {
  console.log(req.body);
  console.log(req.query?.id);
  console.log(req.params);
  if (req.query?.id) {
    Payment.findByIdAndDelete(new objectId(req.query?.id)).then((value) => {
      console.log(value);
      //  clientdb.disconnect()
      res.status(200).json({ message: "Payment deleted successfuly" });
    });
  } else {
    res.status(400).json({ message: "no data found" });
  }
});

//Update one payment Data
router.put(
  "/update_payment",
  bodyParser.json({ extended: true }),
  (req, res) => {
    console.log(req.body);
    console.log(req.query?.id);
    console.log(req.params);

    if (req.body) {
      Payment.findByIdAndUpdate(new objectId(req.query?.id), req.body).then(
        (value) => {
          console.log(value);
          //  clientdb.disconnect()
          res.status(200).json({ message: "payment updated successfuly" });
        },
      );
    } else {
      res.status(400).json({ message: "no data found" });
    }
  },
);

//get students that not paid this month
router.get("/get_not_pay", async (req, res) => {
  console.log("get students");
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { startDate, endDate, code, name, phone } = req.query;

  const today = new Date(); // ✅ Fix 1: defined today

  const matchData = () => {
    const match = {};

    if (startDate && endDate) {
       match.date = {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        }
    } 
    
    return match;
  };

  const matchStudents = () => {
    const match = {};

    if (code) {
      match.code= Number(code);
    }

    if (name) {
      match.$expr = {
          $regexMatch: {
            input: "$name",
            regex: name,
            options: "i",
          }
      };
    }

    if (phone) {
       match.$or = [
          { phone_1: { $regex: phone, $options: "i" } },
          { phone_2: { $regex: phone, $options: "i" } },
          { phone_3: { $regex: phone, $options: "i" } },
        ]
    }

    if (endDate) {
        match.date = { $lte: new Date(endDate) }
    } 
      return match;
  };

  const matchActiveOrInactive = () => {
    if (startDate) {
      const start = new Date(startDate);
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);

      const isCurrentMonth =
        start.getMonth() === today.getMonth() &&
        start.getFullYear() === today.getFullYear(); // ✅ Fix 2: also compare year

      if (isCurrentMonth) {
        // Current month: only check active_status on the Student document
        return { active_status: "active" };
      } else {
        // Past month: active in Student table AND was not deactivated that month
        return {
          $and: [
            { active_status: "active" },
            {
              $or: [
                { activeOrInactiveDetails: { $size: 0 } },
                {
                  activeOrInactiveDetails: {
                    $not: {
                      $elemMatch: { activeStatus: "in_active" },
                    },
                  },
                },
              ],
            },
          ],
        };
      }
    } else {
      // ✅ Fix 3: No startDate → still enforce active_status (was returning {} before)
      return { active_status: "active" };
    }
  };

  await Student.aggregate([
    {
      $lookup: {
        from: Payment.collection.name,
        localField: "_id",
        foreignField: "student",
        as: "payments",
      },
    },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name,
        let: { studentId: "$_id" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails",
      },
    },
    {
      $match: {
        ...matchActiveOrInactive(), // ✅ always filters active students
      },
    },
    {
      $match: {
        payments: {
          $not: {
            $elemMatch: matchData(),
          },
        },
      },
    },
    {
      $match: {
        ...matchStudents(),
        is_payment: "لا",
        // ✅ active_status removed here — handled by matchActiveOrInactive()
      },
    },
    {
      $sort: { code: 1 },
    },
    {
      $facet: {
        metaData: [
          { $count: "total" },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        totalAmount: [{ $group: { _id: null, total: { $sum: "$amount" } } }],
        data: [
          { $skip: Number((page - 1) * limit) },
          { $limit: Number(limit) },
        ],
      },
    },
  ])
    .exec()
    .then((data) => {
      console.log(data);
      res.status(200).send(data[0]);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Paid expenses (المصروفات المدفوعة)
//
// A ledger of every payment recorded for an existing student, newest first, with
// totals for the whole filtered set (not just the current page).
//
//   GET /paid-expenses?page=1&limit=20&from=YYYY-MM-DD&to=YYYY-MM-DD&code=&name=&phone=
//   GET /paid-expenses/monthly?year=2026
//
// `from` / `to` are calendar days (inclusive) in the server's local time zone — the same
// zone the payment dates were entered in.
// ─────────────────────────────────────────────────────────────────────────────
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/** Builds the `date` filter. Returns `null` when a value is not a valid YYYY-MM-DD day. */
function paymentDateRange(from, to) {
  const range = {};
  if (from) {
    if (!DAY_FORMAT.test(from)) return null;
    range.$gte = new Date(`${from}T00:00:00`);
  }
  if (to) {
    if (!DAY_FORMAT.test(to)) return null;
    range.$lte = new Date(`${to}T23:59:59.999`);
  }
  if (Object.values(range).some((d) => Number.isNaN(d.getTime()))) return null;
  return range;
}

/** Student-side filters (applied after the join). Text is escaped, never used as a raw regex. */
function paidExpensesStudentMatch({ code, name, phone }) {
  const match = {};
  if (code !== undefined && String(code).trim() !== "") {
    const parsed = Number(code);
    if (!Number.isNaN(parsed)) match["studentDetails.code"] = parsed;
  }
  if (name && String(name).trim() !== "") {
    match["studentDetails.name"] = {
      $regex: escapeRegex(String(name).trim()),
      $options: "i",
    };
  }
  if (phone && String(phone).trim() !== "") {
    const rx = { $regex: escapeRegex(String(phone).trim()), $options: "i" };
    match.$or = [
      { "studentDetails.phone_1": rx },
      { "studentDetails.phone_2": rx },
      { "studentDetails.phone_3": rx },
    ];
  }
  return match;
}

router.get("/paid-expenses", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const { from, to } = req.query;

    const dateRange = paymentDateRange(from, to);
    if (dateRange === null) {
      return res.status(400).json({ message: "from / to must be valid dates in the form YYYY-MM-DD" });
    }

    const pipeline = [];
    if (Object.keys(dateRange).length) pipeline.push({ $match: { date: dateRange } });
    pipeline.push(
      {
        $lookup: {
          from: "students",
          localField: "student",
          foreignField: "_id",
          as: "studentDetails",
        },
      },
      // payments whose student was deleted are left out
      { $unwind: { path: "$studentDetails", preserveNullAndEmptyArrays: false } },
    );
    const studentMatch = paidExpensesStudentMatch(req.query);
    if (Object.keys(studentMatch).length) pipeline.push({ $match: studentMatch });

    pipeline.push(
      { $sort: { date: -1, createdAt: -1, _id: -1 } },
      {
        $facet: {
          total: [{ $count: "total" }],
          summary: [
            {
              $group: {
                _id: null,
                totalAmount: { $sum: "$amount" },
                paymentsCount: { $sum: 1 },
                students: { $addToSet: "$student" },
              },
            },
          ],
          data: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                amount: 1,
                date: 1,
                student: 1,
                createdAt: 1,
                "studentDetails._id": 1,
                "studentDetails.code": 1,
                "studentDetails.name": 1,
                "studentDetails.image": 1,
                "studentDetails.phone_1": 1,
                "studentDetails.phone_2": 1,
                "studentDetails.phone_3": 1,
                "studentDetails.active_status": 1,
              },
            },
          ],
        },
      },
    );

    const [result] = await Payment.aggregate(pipeline);
    const total = result.total[0]?.total || 0;
    const summary = result.summary[0];
    const totalAmount = summary?.totalAmount || 0;
    const paymentsCount = summary?.paymentsCount || 0;

    res.status(200).send({
      data: result.data,
      metaData: {
        total,
        count: result.data.length,
        pageNumber: page,
        totalPages: Math.ceil(total / limit),
      },
      summary: {
        totalAmount,
        paymentsCount,
        studentsCount: summary?.students?.length || 0,
        averagePayment: paymentsCount ? Math.round(totalAmount / paymentsCount) : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Totals per month of one year (for the month picker / mini chart).
// Months are bucketed in Node (local time zone) rather than with MongoDB's `$month` + timezone, because the
// bundled MongoDB time-zone data does not know Egypt's daylight saving time (see /attendance-stats).
router.get("/paid-expenses/monthly", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    if (year < 2000 || year > 2100) {
      return res.status(400).json({ message: "year must be between 2000 and 2100" });
    }

    // coarse UTC window (±2 days around the year); exact local bucketing happens below
    const payments = await Payment.aggregate([
      {
        $match: {
          date: { $gte: new Date(Date.UTC(year - 1, 11, 30)), $lt: new Date(Date.UTC(year + 1, 0, 3)) },
        },
      },
      { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "studentDetails" } },
      { $unwind: { path: "$studentDetails", preserveNullAndEmptyArrays: false } },
      { $project: { _id: 0, amount: 1, date: 1 } },
    ]);

    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: 0, count: 0 }));
    for (const p of payments) {
      const when = new Date(p.date);
      if (when.getFullYear() !== year) continue;
      months[when.getMonth()].total += p.amount || 0;
      months[when.getMonth()].count += 1;
    }
    res.status(200).send({
      year,
      months,
      yearTotal: months.reduce((sum, m) => sum + m.total, 0),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Attendance statistics (احصائيات الحضور بالمقرأة)
//
//   GET /attendance-stats?year=2026&month=10&scope=all|active
//
// Attendance is stored as one document per student holding an array of class days
// (`attend_days_month`), each day with a status:  حاضر (present) · غائب (absent) · ___ (not recorded).
// Days are scheduled in advance, so most `___` days are simply still in the future — the attendance
// RATE is therefore computed on recorded days only:  present / (present + absent).
//
//  - `month` omitted  → the summary covers the whole year; `daily` is not returned.
//  - `scope=active`   → only students that are currently active; default is every student.
//
// Months / days are bucketed here in Node (local time zone), NOT with MongoDB's `$dateToParts`:
// the bundled MongoDB time-zone data does not know Egypt's daylight saving time, so around midnight
// it would put summer days into the previous day / month. MongoDB only does a coarse window filter.
//
// Student buckets (per period):
//   came        — attended at least once                       (القادمون)
//   cameRate    — came / scheduled, but null while nothing has been recorded in the period
//   absentOnly  — has absences but never attended
//   noRecord    — scheduled, nothing recorded yet
// ─────────────────────────────────────────────────────────────────────────────
const attendanceRate = (present, absent) =>
  present + absent > 0 ? Math.round((present / (present + absent)) * 1000) / 10 : null;
const percentOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

router.get("/attendance-stats", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    if (year < 2000 || year > 2100) {
      return res.status(400).json({ message: "year must be between 2000 and 2100" });
    }
    let month = null;
    if (req.query.month !== undefined && req.query.month !== "") {
      month = parseInt(req.query.month, 10);
      if (!(month >= 1 && month <= 12)) {
        return res.status(400).json({ message: "month must be between 1 and 12" });
      }
    }
    const scope = req.query.scope === "active" ? "active" : "all";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Coarse UTC window around the year (±2 days covers every local offset); exact bucketing is below.
    const windowFrom = new Date(Date.UTC(year - 1, 11, 30));
    const windowTo = new Date(Date.UTC(year + 1, 0, 3));
    const iso = (d) => d.toISOString();

    const rows = await Attendance.aggregate([
      { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "studentDetails" } },
      { $unwind: "$studentDetails" }, // attendance of deleted students is ignored
      ...(scope === "active" ? [{ $match: { "studentDetails.active_status": "active" } }] : []),
      { $unwind: "$attend_days_month" },
      {
        $match: {
          $or: [
            // days are stored as ISO strings, which sort chronologically…
            { "attend_days_month.date": { $gte: iso(windowFrom), $lt: iso(windowTo) } },
            // …but tolerate real BSON dates too
            { "attend_days_month.date": { $gte: windowFrom, $lt: windowTo } },
          ],
        },
      },
      {
        $project: {
          _id: 0,
          student: 1,
          status: "$attend_days_month.status",
          weekday: "$attend_days_month.day",
          date: "$attend_days_month.date",
        },
      },
    ]);

    // ---- bucket in local time
    const newMonth = () => ({ present: 0, absent: 0, total: 0, scheduled: new Set(), came: new Set() });
    const months = Array.from({ length: 12 }, newMonth);
    const period = { present: 0, absent: 0, total: 0 };
    const periodStudents = new Map(); // student -> { present, absent }
    const days = new Map(); // day of month -> { present, absent, total, weekday }

    for (const r of rows) {
      const when = new Date(r.date);
      if (Number.isNaN(when.getTime()) || when.getFullYear() !== year) continue;
      const m = when.getMonth(); // 0-based
      const present = r.status === "حاضر" ? 1 : 0;
      const absent = r.status === "غائب" ? 1 : 0;
      const sid = String(r.student);

      const bucket = months[m];
      bucket.present += present;
      bucket.absent += absent;
      bucket.total += 1;
      bucket.scheduled.add(sid);
      if (present) bucket.came.add(sid);

      if (month === null || m + 1 === month) {
        period.present += present;
        period.absent += absent;
        period.total += 1;
        const s = periodStudents.get(sid) || { present: 0, absent: 0 };
        s.present += present;
        s.absent += absent;
        periodStudents.set(sid, s);
        if (month !== null) {
          const day = days.get(when.getDate()) || { present: 0, absent: 0, total: 0, weekday: r.weekday };
          day.present += present;
          day.absent += absent;
          day.total += 1;
          days.set(when.getDate(), day);
        }
      }
    }

    let came = 0;
    let absentOnly = 0;
    for (const s of periodStudents.values()) {
      if (s.present > 0) came += 1;
      else if (s.absent > 0) absentOnly += 1;
    }
    const scheduled = periodStudents.size;
    const recorded = period.present + period.absent;

    const monthly = months.map((m, i) => ({
      month: i + 1,
      present: m.present,
      absent: m.absent,
      unrecorded: m.total - m.present - m.absent,
      attendanceRate: attendanceRate(m.present, m.absent),
      studentsScheduled: m.scheduled.size,
      studentsCame: m.came.size,
      cameRate: m.present + m.absent > 0 ? percentOf(m.came.size, m.scheduled.size) : null,
    }));

    const [totalStudents, activeStudents] = await Promise.all([
      Student.countDocuments({}),
      Student.countDocuments({ active_status: "active" }),
    ]);

    const pad = (n) => String(n).padStart(2, "0");
    res.status(200).send({
      year,
      month,
      scope,
      timezone,
      summary: {
        present: period.present,
        absent: period.absent,
        unrecorded: period.total - recorded,
        scheduledDays: period.total,
        recordedDays: recorded,
        attendanceRate: attendanceRate(period.present, period.absent),
        students: {
          scheduled,
          came,
          absentOnly,
          noRecord: scheduled - came - absentOnly,
          // no recorded day yet ⇒ "no data", not "0% came"
          cameRate: recorded > 0 ? percentOf(came, scheduled) : null,
        },
      },
      ...(month
        ? {
            daily: [...days.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([day, d]) => ({
                date: `${year}-${pad(month)}-${pad(day)}`,
                weekday: d.weekday,
                present: d.present,
                absent: d.absent,
                unrecorded: d.total - d.present - d.absent,
                attendanceRate: attendanceRate(d.present, d.absent),
              })),
          }
        : {}),
      monthly,
      // current snapshot, independent of the period
      students: {
        total: totalStudents,
        active: activeStudents,
        inactive: totalStudents - activeStudents,
        activeRate: percentOf(activeStudents, totalStudents),
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

//Get Attendance
router.get("/get_attendance", async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { date, code, name, phone } = req.query;
  const today = new Date();
  //  today.setHours(0, 0, 0, 0);
  const matchData = () => {
    const conditions = [];

    if (code && String(code).trim() !== "") {
      const parsedCode = Number(code);
      if (!Number.isNaN(parsedCode)) {
        conditions.push({ "studentDetails.code": parsedCode });
      }
    }

    if (name && name.trim() !== "") {
      conditions.push({
        $expr: {
          $regexMatch: {
            input: "$studentDetails.name",
            regex: name,
            options: "i",
          },
        },
      });
    }

    if (phone && phone.trim() !== "") {
      conditions.push({
        $or: [
          { "studentDetails.phone_1": { $regex: phone, $options: "i" } },
          { "studentDetails.phone_2": { $regex: phone, $options: "i" } },
          { "studentDetails.phone_3": { $regex: phone, $options: "i" } },
        ],
      });
    }

    if (date && date.trim() !== "") {
      conditions.push({
        date: new Date(date),
      });
    }

    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0];

    // ── Spread all conditions into a single flat match object ──
    return Object.assign({}, ...conditions);
  };
  console.log(matchData());
  // const matchData = Object.keys(req.query).filter(value => value !== undefined).map(d => {
  //   if (d == "date"){
  //     return {date:req.query[d]}
  //   }else {
  //     return {}
  //   }
  // })

  await Attendance.aggregate([
    {
      $lookup: {
        from: "students", // Name of the other collection
        localField: "student", // Field from the attendance documents
        foreignField: "_id", // Field from the students documents
        as: "studentDetails", // Output array field
      },
    },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$student" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          { $project: { student: 1, activatedDate: 1, activeStatus: 1 } },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $unwind: {
        path: "$studentDetails", // Unwind the studentDetails array
        preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
      },
    },
    {
      $addFields: {
        isToday: {
          $and: [
            {
              $ne: ["$status", "_"], // Check if updatedDate is today
            },

            {
              $eq: ["$date", new Date(new Date().toLocaleDateString("en-CA"))],
            },
          ],
        },
        isAbsence: {
          $and: [
            {
              $eq: ["$status", "غائب"],
            },
            {
              $eq: ["$date", new Date(new Date().toLocaleDateString("en-CA"))],
            },
          ],
        },
        studentDetails: "$studentDetails", // Move studentDetails back to top level
      },
    },
    {
      $match: {
        activeOrInactiveDetails: {
          $not: {
            $elemMatch: {
              activeStatus: "in_active",
            },
          },
        },
        "studentDetails.active_status": "active",
      },
    },
    {
      $match: {
        ...matchData(),
      },
    },
    {
      $sort: {
        // "studentDetails.name": 1,
        isToday: 1, // Sort by isToday in ascending order (true first)
        isAbsence: 1,
        "studentDetails.code": 1,
      },
    },
    {
      $facet: {
        metaData: [
          {
            $count: "total",
          },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        data: [
          {
            $skip: Number((page - 1) * limit),
          },
          {
            $limit: Number(limit),
          },
        ],
        attendanceDetails: [
          {
            $group: {
              _id: null,
              totalStudents: { $sum: 1 },
              totalAbsent: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "غائب"] },
                        {
                          $eq: [
                            "$date",
                            new Date(new Date().toLocaleDateString("en-CA")),
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              totalAttend: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$status", "حاضر"] },
                        {
                          $eq: [
                            "$date",
                            new Date(new Date().toLocaleDateString("en-CA")),
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ])
    .then((data) => {
      console.log("attendance ===>", data);
      let result = data[0];
      result.metaData = {
        ...data[0].metaData[0],
        count: data[0]?.data?.length,
      };
      res.status(200).send(result);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

//Add new Attendance
router.post(
  "/add_attendance",
  bodyParser.json({ extended: true }),
  async (req, res) => {
    const attend_days_month = req.body.attend_days_month;
    const student = req.query.studentId;
    await Attendance.create({ ...req.body, student: req.query.studentId })
      .then((data) => {
        console.log(data);
        res.status(200).json({ message: "Attendance added success", data });
      })
      .catch((err) => {
        res.status(400).json({ message: err.message });
      });
  },
);

//Update one Attendance Data
router.put(
  "/update_attendance",
  bodyParser.json({ extended: true }),
  (req, res) => {
    console.log(req.body);
    console.log(req.query?.id);
    console.log(req.params);

    if (req.body) {
      Attendance.findByIdAndUpdate(new objectId(req.query?.id), req.body, {
        new: true,
      }).then((value) => {
        console.log(value);
        //  clientdb.disconnect()
        res
          .status(200)
          .json({ message: "Attendance updated successfuly", data: value });
      });
    } else {
      res.status(400).json({ message: "no data found" });
    }
  },
);

//delete one Attendance Data
router.delete("/delete_attendance", (req, res) => {
  // console.log(req.body);
  console.log(req.query?.id);
  // console.log(req.params);
  if (req.query?.id) {
    Attendance.findByIdAndDelete(new objectId(req.query?.id)).then((value) => {
      console.log(value);
      //  clientdb.disconnect()
      res.status(200).json({ message: "Attendance deleted successfuly" });
    });
  } else {
    res.status(400).json({ message: "no data found" });
  }
});

//Get Reports
router.get("/reports", async (req, res) => {
  const { startDate, endDate } = req.query;
  // console.log(startDate, endDate);
  const matchData = () => {
    if (startDate && endDate) {
      return {
        date: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        },
      };
    } else {
      return {};
    }
  };

  const matchActiveOrInactive = () => {
    if (startDate) {
      console.log(new Date(startDate));
      const start = new Date(startDate);
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);
      console.log(start.getMonth());
      if (start.getMonth() + 1 == today.getMonth() + 1) {
        return { active_status: "active" };
      } else
        return {
          activeOrInactiveDetails: {
            $exists: true,
            $not: {
              $elemMatch: {
                activeStatus: "in_active",
              },
            },
          },
        };
    } else {
      return {};
    }
  };

  const matchActiveOrInactivePay = () => {
    if (startDate) {
      console.log(new Date(startDate));
      const start = new Date(startDate);
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);
      console.log(start.getMonth());
      if (start.getMonth() + 1 == today.getMonth() + 1) {
        return { "studentDetails.active_status": "active" };
      } else
        return {
          activeOrInactiveDetails: {
            $exists: true,
            $not: {
              $elemMatch: {
                activeStatus: "in_active",
              },
            },
          },
        };
    } else {
      return {};
    }
  };
  // const matchData = Object.keys(req.query).filter(value => value !== undefined).map(d => {
  //   if (d == "date"){
  //     return {date:req.query[d]}
  //   }else {
  //     return {}
  //   }
  // })
  // console.log(matchData());
  const amountOfAllStudents = await Student.aggregate([
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$_id" },
        pipeline: [
          {
            $lookup: {
              from: "students", // Name of the other collection
              localField: "student", // Field from the attendance documents
              foreignField: "_id", // Field from the students documents
              as: "studentDetails", // Output array field
            },
          },
          {
            $unwind: {
              path: "$studentDetails", // Unwind the studentDetails array
              preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
            },
          },
          {
            $addFields: {
              studentDetails: "$studentDetails", // Move studentDetails back to top level
            },
          },
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          {
            $project: {
              student: 1,
              activatedDate: 1,
              activeStatus: 1,
              studentDetails: 1,
            },
          },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        ...matchActiveOrInactive(),
      },
    },
    {
      $group: {
        _id: null, // Group all documents together
        totalAmount: { $sum: "$amount" }, // Sum the 'amount' field
        totalCount: { $sum: 1 },
      },
    },
  ]);

  const payedDays = await Payment.aggregate([
    {
      $match: matchData(),
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
        },
        totalAmount: { $sum: "$amount" },
        payingStudents: { $addToSet: "$student" },
      },
    },
    {
      $project: {
        date: "$_id.date",
        totalAmount: 1,
        studentsCount: { $size: "$payingStudents" },
        _id: 0,
      },
    },
    {
      $sort: {
        date: 1,
        totalAmount: -1,
      },
    },
  ]);

  await Payment.aggregate([
    {
      $lookup: {
        from: "students", // Name of the other collection
        localField: "student", // Field from the attendance documents
        foreignField: "_id", // Field from the students documents
        as: "studentDetails", // Output array field
      },
    },
    {
      $unwind: {
        path: "$studentDetails", // Unwind the studentDetails array
        preserveNullAndEmptyArrays: false, // Optional: Exclude documents without a match
      },
    },
    {
      $addFields: {
        studentDetails: "$studentDetails", // Move studentDetails back to top level
      },
    },
    {
      $lookup: {
        from: ActiveOrInactive.collection.name, // Name of the other collection
        let: { studentId: "$student" },
        pipeline: [
          {
            $match: {
              $and: [
                {
                  $expr: { $eq: ["$student", "$$studentId"] },
                },
                {
                  activatedDate: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                  },
                },
              ],
            },
          },
          {
            $project: {
              student: 1,
              activatedDate: 1,
              activeStatus: 1,
              studentDetails: 1,
            },
          },
        ],
        as: "activeOrInactiveDetails", // Output array field
      },
    },
    {
      $match: {
        ...matchActiveOrInactivePay(),
      },
    },
    {
      $match: matchData(),
    },
    {
      $group: {
        _id: null, // Group all documents together
        totalAmount: { $sum: "$amount" }, // Sum the 'amount' field
      },
    },
  ])
    .then((data) => {
      console.log(data);
      console.log(amountOfAllStudents);

      let newData = {
        historyPayments: payedDays,
        totalAmount: data[0]?.totalAmount || 0,
        amountOfAllStudents: amountOfAllStudents[0]?.totalAmount,
        totalCount: amountOfAllStudents[0]?.totalCount,
      };
      res.status(200).send(newData);
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});
// });

async function getColumnIndexes(workbook, worksheetName) {
  const worksheet = workbook.getWorksheet(worksheetName);
  const headers = worksheet.getRow(1).values;
  const columnIndexes = {};

  headers.forEach((header, index) => {
    columnIndexes[header] = index + 1; // +1 because ExcelJS uses 1-based indexing
  });

  return columnIndexes;
}

// Import data from XLSX file
router.post(
  "/import-students-xlsx",
  upload.single("file"),
  async (req, res) => {
    try {
      // ✅ Validate file exists
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(req.file.path);

      const worksheet = workbook.getWorksheet("Students");

      // ✅ Validate worksheet exists
      if (!worksheet) {
        return res
          .status(400)
          .json({ message: 'Sheet named "Students" not found in the file' });
      }

      const studentsData = [];
      const errors = [];

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header

        const code = row.getCell(1).value;
        const name = row.getCell(2).value;

        // ✅ Validate required fields per row
        if (!code || !name) {
          errors.push(
            `Row ${rowNumber}: missing required fields (code or name)`,
          );
          return;
        }

        const student = {
          code: Number(code),
          name: String(name).trim(),
          phone_1: row.getCell(3).value
            ? String(row.getCell(3).value).trim()
            : null,
          phone_2: row.getCell(4).value
            ? String(row.getCell(4).value).trim()
            : null,
          phone_3: row.getCell(5).value
            ? String(row.getCell(5).value).trim()
            : null,
          study_year: row.getCell(6).value
            ? String(row.getCell(6).value).trim()
            : null,
          date: row.getCell(7).value ? new Date(row.getCell(7).value) : null,
          is_Azhar: row.getCell(8).value
            ? String(row.getCell(8).value).trim()
            : null,
          has_relative: row.getCell(9).value
            ? String(row.getCell(9).value).trim()
            : null,
          is_payment: row.getCell(10).value
            ? String(row.getCell(10).value).trim()
            : null,
          age: row.getCell(11).value ? Number(row.getCell(11).value) : null,
          landline: row.getCell(12).value
            ? String(row.getCell(12).value).trim()
            : null,
          address: row.getCell(13).value
            ? String(row.getCell(13).value).trim()
            : null,
          notes: row.getCell(14).value
            ? String(row.getCell(14).value).trim()
            : null,
          amount: row.getCell(15).value ? Number(row.getCell(15).value) : null,
          active_status: row.getCell(16).value
            ? String(row.getCell(16).value).trim()
            : "active",
        };

        studentsData.push(student);
      });

      if (studentsData.length === 0) {
        return res.status(400).json({
          message: "No valid student rows found in the file",
          errors,
        });
      }

      // ✅ Upsert by code — update if exists, insert if not
      const bulkOps = studentsData.map((student) => ({
        updateOne: {
          filter: { code: student.code },
          update: { $set: student },
          upsert: true, // insert if not found
        },
      }));

      const result = await Student.bulkWrite(bulkOps);

      // ✅ Clean up uploaded file after processing
      const fs = require("fs");
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("Failed to delete temp file:", err);
      });

      return res.status(200).json({
        message: "Students imported successfully",
        inserted: result.upsertedCount,
        updated: result.modifiedCount,
        total: studentsData.length,
        skippedRows: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error("Import error:", error);
      return res.status(500).json({ message: error.message });
    }
  },
);

// Export data to XLSX file
router.get("/export-students-xlsx", async (req, res) => {
  try {
    // Fetch all students from the database
    const students = await Student.find({});

    // Create a new workbook and add a worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Students");

    // Define columns
    worksheet.columns = [
      { header: "code", key: "code", width: 10 },
      { header: "Name", key: "name", width: 20 },
      { header: "phone_1", key: "phone_1", width: 30 },
      { header: "phone_2", key: "phone_2", width: 30 },
      { header: "phone_3", key: "phone_3", width: 30 },
      { header: "study_year", key: "study_year", width: 10 },
      { header: "date", key: "date", width: 20 },
      { header: "is_Azhar", key: "is_Azhar", width: 10 },
      { header: "has_relative", key: "has_relative", width: 10 },
      { header: "is_payment", key: "is_payment", width: 20 },
      { header: "age", key: "age", width: 20 },
      { header: "landline", key: "landline", width: 20 },
      { header: "address", key: "address", width: 20 },
      { header: "notes", key: "notes", width: 20 },
      { header: "amount", key: "amount", width: 20 },
      { header: "active_status", key: "active_status", width: 10 },
    ];

    // Add rows
    students.forEach((student) => {
      worksheet.addRow(student);
    });

    // Write to file
    const fileName = `Students(${new Date().toLocaleDateString("en-CA")}).xlsx`;
    await workbook.xlsx.writeFile(fileName);

    // Send the file as a download
    res.download(fileName, (err) => {
      if (err) {
        console.error(err);
      }
      // Delete the file after sending it
      fs.unlinkSync(fileName);
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error exporting students");
  }
});

router.post(
  "/activate-or-deactivate",
  bodyParser.json({ extended: true }),
  async (req, res) => {
    try {
      const { student, activeStatus, activatedDate } = req.body;

      // ✅ Fix 1: Validate required fields
      if (!student || !activeStatus || !activatedDate) {
        return res
          .status(400)
          .json({
            message: "student, activeStatus, and activatedDate are required",
          });
      }

      // ✅ Fix 2: Compute date range fresh per request, not at module load time
      const activated = new Date(activatedDate);
      const activatedMonth = activated.getMonth(); // 0-based
      const activatedYear = activated.getFullYear();

      // Start = first day of the activated month at 00:00:00
      const stDate = new Date(activatedYear, activatedMonth, 1);
      // End = first day of NEXT month (used with $lt, so excludes end itself)
      const enDate = new Date(activatedYear, activatedMonth + 1, 1);

      console.log(
        "Range:",
        stDate.toLocaleDateString("en-CA"),
        enDate.toLocaleDateString("en-CA"),
      );

      // ✅ Fix 3: Check if the activated month is the current month
      const now = new Date();
      const isCurrentMonth =
        activatedMonth === now.getMonth() &&
        activatedYear === now.getFullYear();

      // ✅ Fix 4: Find existing record for that student in that month
      const existingRecord = await ActiveOrInactive.findOne({
        $and: [
          { student: new objectId(student) },
          {
            activatedDate: {
              $gte: stDate,
              $lt: enDate,
            },
          },
        ],
      });

      console.log("existingRecord =======>", existingRecord);

      // ✅ Fix 5: Update Student active_status only if it's the current month (deduplicated)
      if (isCurrentMonth) {
        await Student.findByIdAndUpdate(new objectId(student), {
          active_status: activeStatus,
        });
      }

      // ✅ Fix 6: Update or create ActiveOrInactive record (no .then() mixing)
      let value;
      if (existingRecord) {
        value = await ActiveOrInactive.findByIdAndUpdate(
          new objectId(existingRecord._id),
          { ...req.body },
          { new: true },
        );
      } else {
        value = await ActiveOrInactive.create({ ...req.body });
      }

      return res
        .status(200)
        .json({ message: "Successfully updated", data: value });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  },
);

// Deactivated students only — optional month/date range (startDate + endDate)
router.get("/get-inactive-students", async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 5;
  const { startDate, endDate, code, name, phone } = req.query;

  const escapeRegex = (value) =>
    String(value).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

  const hasDateRange = Boolean(startDate && endDate);
  const parsedStartDate = hasDateRange ? new Date(startDate) : null;
  const parsedEndDate = hasDateRange ? new Date(endDate) : null;

  if (
    hasDateRange &&
    (Number.isNaN(parsedStartDate.getTime()) ||
      Number.isNaN(parsedEndDate.getTime()))
  ) {
    return res.status(400).json({ message: "Invalid startDate or endDate" });
  }

  const now = new Date();
  const isCurrentMonth =
    hasDateRange &&
    parsedStartDate.getMonth() === now.getMonth() &&
    parsedStartDate.getFullYear() === now.getFullYear();

  const buildSearchMatch = () => {
    const conditions = [];

    if (code !== undefined && String(code).trim() !== "") {
      const parsedCode = Number(code);
      if (!Number.isNaN(parsedCode)) conditions.push({ code: parsedCode });
    }

    if (name && name.trim() !== "") {
      conditions.push({ name: { $regex: escapeRegex(name), $options: "i" } });
    }

    if (phone && phone.trim() !== "") {
      conditions.push({
        $or: [
          { phone_1: { $regex: escapeRegex(phone), $options: "i" } },
          { phone_2: { $regex: escapeRegex(phone), $options: "i" } },
          { phone_3: { $regex: escapeRegex(phone), $options: "i" } },
        ],
      });
    }

    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0];

    return Object.assign({}, ...conditions);
  };

  // ✅ Deactivated match logic
  const buildDeactivatedMatch = () => {
    if (!hasDateRange || isCurrentMonth) {
      return { active_status: "in_active" };
    }

    return {
      $and: [
        // ✅ لازم يكون in_active في جدول Student أساساً
        { active_status: "in_active" },
        {
          $or: [
            // آخر سجل قبل endDate هو in_active
            {
              activeOrInactiveDetails: {
                $elemMatch: { activeStatus: "in_active" },
              },
            },
            // مفيش سجلات خالص بس Student نفسه in_active
            { activeOrInactiveDetails: { $size: 0 } },
          ],
        },
      ],
    };
  };

  // ✅ $lookup only needed for past months
  const needsLookup = hasDateRange && !isCurrentMonth;

  const lookupStage = needsLookup
    ? [
        {
          $lookup: {
            from: ActiveOrInactive.collection.name,
            let: { studentId: "$_id" },
            pipeline: [
              {
                $match: {
                  $and: [
                    { $expr: { $eq: ["$student", "$$studentId"] } },
                    // ✅ كل السجلات قبل نهاية الشهر المختار
                    { activatedDate: { $lt: parsedEndDate } },
                  ],
                },
              },
              // ✅ رتّب من الأحدث للأقدم
              { $sort: { activatedDate: -1 } },
              // ✅ خد آخر سجل بس (الأحدث قبل endDate)
              { $limit: 1 },
              {
                $project: {
                  student: 1,
                  activatedDate: 1,
                  activeStatus: 1,
                },
              },
            ],
            as: "activeOrInactiveDetails",
          },
        },
      ]
    : [];

  await Student.aggregate([
    ...lookupStage,
    {
      $match: {
        ...buildSearchMatch(),
        ...buildDeactivatedMatch(),
      },
    },
    { $sort: { updatedAt: -1 } },
    {
      $facet: {
        metaData: [
          { $count: "total" },
          {
            $addFields: {
              pageNumber: Number(page),
              totalPages: { $ceil: { $divide: ["$total", limit] } },
            },
          },
        ],
        totalAmount: [{ $group: { _id: null, total: { $sum: "$amount" } } }],
        data: [
          { $skip: Number((page - 1) * limit) },
          { $limit: Number(limit) },
        ],
      },
    },
  ])
    .then((data) => {
      const [result] = data;
      res.status(200).json({
        metaData: {
          ...result.metaData[0],
          count: result.data?.length ?? 0,
        },
        totalAmount: result.totalAmount[0]?.total ?? 0,
        data: result.data,
      });
    })
    .catch((e) => {
      res.status(500).json({ message: e.message });
    });
});

router.post(
  "/activate-or-deactivate-students",
  bodyParser.json({ extended: true }),
  async (req, res) => {
    const { startDate, endDate } = req.query;
    const inActiveData = await ActiveOrInactive.find({
      $and: [
        { activeStatus: "in_active" },
        {
          activatedDate: { $gte: new Date(startDate), $lt: new Date(endDate) },
        },
      ],
    });
    const students = await Student.find({ active_status: "in_active" });
    const idList = await inActiveData.map((e) => e.student);
    console.log(idList);

    const activeStatus = await Student.updateMany(
      { _id: { $in: idList } },
      { $set: { active_status: "in_active" } },
    );
    res.status(200).send(activeStatus);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Student options for dropdowns, paginated (so the browser never downloads the whole list)
//
//   GET /students_options?page=1&limit=30&search=احمد&status=active&exclude=id1,id2
//   GET /students_options?ids=id1,id2          → just those students (to label a saved selection)
//
//   search   name (case-insensitive contains), code (digits) or phone number (5+ digits)
//   status   active | in_active   (omit for everyone)
//   exclude  ids to leave out (e.g. relatives already chosen)
//   → { data: [{ _id, name, code, image }], total, page, limit, hasMore }
//
// Students without a name come last, ordered by code.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/students_options", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const toIds = (value) =>
      String(value || "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => objectId.isValid(v))
        .map((v) => new objectId(v));

    const match = {};
    if (req.query.ids) {
      match._id = { $in: toIds(req.query.ids) };
    } else {
      if (req.query.status) match.active_status = String(req.query.status);
      const exclude = toIds(req.query.exclude);
      if (exclude.length) match._id = { $nin: exclude };
      const search = String(req.query.search || "").trim();
      if (search) {
        const or = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
        if (/^\d+$/.test(search)) {
          or.push({ code: Number(search) });
          // long digit strings are phone numbers (any of the three)
          if (search.length >= 5) {
            const rx = { $regex: escapeRegex(search), $options: "i" };
            or.push({ phone_1: rx }, { phone_2: rx }, { phone_3: rx });
          }
        }
        match.$or = or;
      }
    }

    const [rows, total] = await Promise.all([
      Student.aggregate([
        { $match: match },
        { $addFields: { emptyName: { $cond: [{ $in: ["$name", [null, ""]] }, 1, 0] } } },
        { $sort: { emptyName: 1, name: 1, code: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { name: 1, code: 1, image: 1 } },
      ]),
      Student.countDocuments(match),
    ]);
    res.status(200).send({ data: rows, total, page, limit, hasMore: page * limit < total });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
